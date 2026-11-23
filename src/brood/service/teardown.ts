import { promises as fs } from "node:fs";
import path from "node:path";
import { recordBroodTeardown } from "../../observability/brood-metrics.js";
import {
  startBroodSpan,
  type BroodChildSpan,
} from "../../observability/brood-trace.js";
import { spawnContainerName } from "../../spawn/container-launch.js";
import { readContainerLogsAsync } from "./docker-logs.js";
import type { SessionRepository } from "./repository.js";
import {
  defaultStewardGateway,
  removeStewardViaCastra,
  type StewardRemovalResult,
} from "./steward-removal.js";
import {
  archiveTeardownEvidence,
  sameSteward,
  stewardIdentity,
  TeardownArchive,
  type StewardIdentity,
  teardownResources,
  type TeardownResources,
} from "./teardown-archive.js";
import { broodArchiveDir } from "./store.js";
import {
  TEARDOWN_FINALIZATION_MS,
  TEARDOWN_REQUEST_MS,
  TeardownDeadlineError,
  teardownCall,
} from "./teardown-deadline.js";
import {
  hostTeardownSubstrate,
  type ComputeTarget,
  type StopComputeResult,
  type TeardownSubstrate,
} from "./substrate.js";
import type {
  SessionRecord,
  TeardownRequest,
  TeardownResult,
  TeardownStep,
} from "./types.js";

export const TEARDOWN_DETAIL_LIMIT = 500;

/** The requested session does not exist. Routes map this to HTTP 404. */
export class BroodNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroodNotFoundError";
  }
}

/** A live spawn cannot be torn down without `force`. Routes map this to 409. */
export class BroodConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BroodConflictError";
  }
}

/** Side-effecting operations, injectable so teardown is unit-testable. */
export interface TeardownDeps {
  /**
   * Substrate adapter for container + worktree/branch reclamation. Defaults to
   * {@link hostTeardownSubstrate}; swap it to retarget teardown at another
   * substrate (e.g. an orchestrator API + ephemeral volume). See `substrate.ts`.
   */
  substrate?: TeardownSubstrate;
  readContainerLogs?: (containerId: string) => string | Promise<string>;
  /**
   * Remove the steward from Castra. Resolves the real live session(s) for the
   * steward's worktree and returns a verifying outcome (`removed`/`absent`/
   * `failed`) — teardown marks `torndown` only on the first two and DEFERS on
   * `failed`. Defaults to {@link removeStewardViaCastra} over the env Castra
   * client. See `steward-removal.ts` for the #304 id-mismatch rationale.
   */
  removeSteward?: (input: {
    sessionId: string;
    profile?: string;
    worktreePath?: string;
    branch?: string;
  }, signal?: AbortSignal) => Promise<StewardRemovalResult>;
  pathExists?: (p: string) => boolean | Promise<boolean>;
  homeDir?: string;
  now?: () => string;
  /** Inbound W3C traceparent so the teardown span nests under the caller's trace. */
  traceparent?: string;
}

interface ResolvedDeps {
  substrate: TeardownSubstrate;
  readContainerLogs: (containerId: string) => string | Promise<string>;
  removeSteward: (input: {
    sessionId: string;
    profile?: string;
    worktreePath?: string;
    branch?: string;
  }, signal: AbortSignal) => Promise<StewardRemovalResult>;
  pathExists: (p: string) => boolean | Promise<boolean>;
  homeDir?: string;
  now: () => string;
}

/**
 * Default steward removal — delegate to Castra (#153/#165), the interactive-
 * sessions host that owns agent-deck. Brood owns the worktree, so removal asks
 * Castra to drop the session WITHOUT pruning the worktree (`pruneWorktree:
 * false`) and Brood removes the worktree itself by exact path afterward.
 *
 * Resolves the steward's REAL live session id from Castra's session list by exact
 * worktree match rather than trusting the tracked id, which goes stale after a
 * legate relaunch re-keys the steward (issue #304). Returns a verifying outcome:
 * `failed` (Castra unreachable / removal errored) makes teardown DEFER instead of
 * leaking; `absent` means Castra confirmed no session for this worktree.
 */
async function defaultRemoveSteward(input: {
  sessionId: string;
  profile?: string;
  worktreePath?: string;
  branch?: string;
}, signal: AbortSignal): Promise<StewardRemovalResult> {
  return removeStewardViaCastra(defaultStewardGateway(), input, signal);
}

async function pathExists(file: string): Promise<boolean> {
  try {
    await fs.stat(file);
    return true;
  } catch (error) {
    const { code } = error as NodeJS.ErrnoException;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw error;
  }
}

function resolveDeps(deps: TeardownDeps): ResolvedDeps {
  return {
    substrate: deps.substrate ?? hostTeardownSubstrate,
    readContainerLogs: deps.readContainerLogs ?? ((id) => readContainerLogsAsync(id, { timeoutMs: 4_000 })),
    removeSteward: deps.removeSteward ?? defaultRemoveSteward,
    pathExists: deps.pathExists ?? pathExists,
    homeDir: deps.homeDir,
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

const activeTeardowns = new Map<string, Promise<TeardownResult>>();

/**
 * Stop compute when needed, then archive before removing any runtime artifacts.
 * A failed step keeps the session retryable. The workspace is shared with the
 * steward, so Git cleanup requires verified steward removal.
 */
export async function teardownSession(
  store: SessionRepository,
  id: string,
  request: TeardownRequest = {},
  deps: TeardownDeps = {},
): Promise<TeardownResult> {
  const deadline = performance.now() + TEARDOWN_REQUEST_MS;
  // Serialize requests for the same archive, including requests by steward ID.
  // Re-resolve the key after each wait: a queued steward can be re-registered
  // under another spawn while it waits, and must then queue on that archive.
  for (;;) {
    const key = archiveKey(store, id, deps.homeDir);
    const previous = activeTeardowns.get(key);
    if (previous) {
      try {
        await teardownCall("teardown queue", deadline, () => previous.catch(() => undefined));
      } catch (error) {
        const primaryId = path.basename(archiveKey(store, id, deps.homeDir));
        const span = startBroodSpan({ name: "brood.teardown", key: primaryId, traceparent: deps.traceparent });
        const detail = message(error);
        const step: TeardownStep = { step: "archive", outcome: "failed", detail };
        endStepSpan(span.startChild("brood.teardown.archive"), step);
        span.event("teardown.archive", { outcome: step.outcome, detail });
        span.setAttributes({ "march.teardown.outcome": "error" });
        span.end({ error: true });
        return { id: primaryId, status: "tearing-down", steps: [step], warnings: [detail] };
      }
      continue;
    }
    const current = runTeardown(store, id, request, deps, key, deadline);
    activeTeardowns.set(key, current);
    try {
      return await current;
    } finally {
      if (activeTeardowns.get(key) === current) activeTeardowns.delete(key);
    }
  }
}

function archiveKey(store: SessionRepository, id: string, homeDir: string | undefined): string {
  const target = store.get(id);
  const parent = target?.kind === "steward" && target.parentId
    ? store.get(target.parentId)
    : undefined;
  return path.resolve(broodArchiveDir(parent?.kind === "spawn" ? parent.id : id, homeDir));
}

async function runTeardown(
  store: SessionRepository,
  id: string,
  request: TeardownRequest,
  deps: TeardownDeps,
  key: string,
  deadline: number,
): Promise<TeardownResult> {
  const d = resolveDeps(deps);
  const target = store.get(id);
  if (!target) {
    const span = startBroodSpan({
      name: "brood.teardown",
      key: id,
      traceparent: deps.traceparent,
      attributes: { "march.session.id": id },
    });
    rejectTeardown(
      span,
      "not-found",
      new BroodNotFoundError(`No session with id "${id}".`),
    );
  }

  // Resolve the spawn<->steward group. The spawn row carries the canonical
  // container/worktree/branch; the steward row carries the agent-deck session.
  const parent = target.kind === "steward" && target.parentId ? store.get(target.parentId) : undefined;
  const spawn = target.kind === "spawn" ? target : parent?.kind === "spawn" ? parent : undefined;
  const stewards = spawn ? store.list({ parentId: spawn.id, kind: "steward" }) : [];
  const liveStewards = stewards.filter((row) => row.status !== "torndown");
  // Keep the addressed steward for evidence. Cleanup covers every live member
  // of the group, regardless of which row the request addresses.
  const steward =
    target.kind === "steward"
      ? target
      : liveStewards[0] ?? stewards[0];
  const groupStewards = spawn ? liveStewards : steward ? [steward] : [];
  const groupStewardIds = groupStewards.map((row) => row.id);

  // `primary` owns the worktree/branch/container; fall back to the target row.
  const primary: SessionRecord = spawn ?? target;

  const steps: TeardownStep[] = [];
  const warnings: string[] = [];
  const startMs = Date.now();
  const span = startBroodSpan({
    name: "brood.teardown",
    key: primary.id,
    traceparent: deps.traceparent,
    attributes: {
      "march.session.id": primary.id,
      "march.session.kind": primary.kind,
      ...(spawn ? { "march.spawn.id": spawn.id } : {}),
      ...(steward ? { "march.steward.id": steward.id } : {}),
      ...(primary.worktreePath
        ? { "march.worktree.path": primary.worktreePath }
        : {}),
    },
  });

  if (primary.status === "torndown" && liveStewards.length === 0) {
    return finish("success");
  }

  function call<T>(
    name: string,
    budget: number,
    operation: (signal: AbortSignal) => T | Promise<T>,
    fence = true,
  ): Promise<T> {
    return teardownCall(name, Math.min(deadline - TEARDOWN_FINALIZATION_MS, performance.now() + budget),
      operation, fence ? key : undefined);
  }

  const dir = path.resolve(broodArchiveDir(primary.id, d.homeDir));
  let archive: TeardownArchive | undefined;
  let archiveError: unknown;
  const pending = store.pendingTeardownCompletion(primary.id);
  try {
    if (path.dirname(dir) !== path.resolve(broodArchiveDir("", d.homeDir)) ||
        path.basename(dir) !== primary.id) {
      throw new Error("Invalid session identity for teardown archive");
    }
    archive = new TeardownArchive(dir);
    if (pending !== undefined) {
      const evidence = archive;
      await call("archive read", 3_000, (signal) => evidence.load(signal));
      const current = store.get(primary.id);
      if (!current || !sameResources(teardownResources(primary), teardownResources(current))) {
        throw new Error("primary registration changed during archive recovery; retry teardown");
      }
    }
  } catch (error) {
    archive = undefined;
    archiveError = error;
    if (pending !== undefined) {
      const detail = message(error);
      const step: TeardownStep = { step: "archive", outcome: "failed", detail };
      steps.push(step);
      warnings.push(`archive recovery failed: ${detail}`);
      endStepSpan(span.startChild("brood.teardown.archive"), step);
      deferSteps(["container", "steward", "worktree", "branch"], "archive recovery failed");
      return finish("error");
    }
  }
  const completion = archive?.completion;
  const recoveredStewards = completion ? unchangedStewardIds(completion.stewards ?? []) : [];
  // A standalone steward is its own primary: recover it only while its
  // registration still matches the removed session; otherwise tear down anew.
  const primaryUnchanged = primary.kind !== "steward" || recoveredStewards.includes(primary.id);
  if (completion && completion.attempt === pending &&
      sameResources(completion.resources, teardownResources(primary)) && primaryUnchanged) {
    // A crash after the terminal journal write can leave one or both rows
    // behind, possibly followed by a status-only PATCH. Finish the registry
    // update for the group the attempt verified, without repeating cleanup.
    // A re-registration that changed resource identity falls through to a
    // real teardown of the new resources instead.
    // Complete only steward registrations that still match what the attempt
    // removed (same row, parent, and Castra target); a re-registered steward
    // was never verified gone and is left for a real retry.
    const verified = recoveredStewards;
    completeRegistry(completion.at, verified);
    return unremovedStewards(verified) ? finish("partial") : finish("success");
  }

  // A stored force decision holds until teardown completes, even if a
  // lifecycle PATCH has since moved the row out of `tearing-down`. Older
  // in-progress rows lack a recorded decision; require force when their
  // pre-teardown state is unknown. The registry write precedes archiving.
  const requiresForce =
    spawn &&
    (spawn.status === "running" ||
      spawn.status === "created" ||
      spawn.teardownRequiresForce === true ||
      (spawn.status === "tearing-down" && spawn.teardownRequiresForce !== false));
  if (requiresForce && !request.force) {
    rejectTeardown(
      span,
      "conflict",
      new BroodConflictError(
        `Spawn "${spawn.id}" is ${spawn.status}. Pass force to tear it down.`,
      ),
    );
  }

  const archiveSpan = span.startChild("brood.teardown.archive");
  let snapshot: string;
  try {
    snapshot = store.beginTeardown(
      primary.id,
      groupStewardIds,
      JSON.stringify({
        session: snapshotRow(primary),
        spawn: spawn && snapshotRow(spawn),
        steward: steward && snapshotRow(steward),
      }, null, 2) + "\n",
      { teardownReason: request.reason, teardownRequiresForce: requiresForce },
    );
  } catch (error) {
    endStepSpan(archiveSpan, { step: "archive", outcome: "failed", detail: message(error) });
    span.end({ error: true });
    throw error;
  }

  // Stewards whose Castra removal this attempt verified (`removed` or `absent`).
  const verifiedStewards: StewardIdentity[] = [];
  let attempt: number | undefined;
  const activeEphemeral = !spawn &&
    ["running", "created", "tearing-down"].includes(primary.status);
  const shouldStop = !request.kill && (spawn || primary.containerId) &&
    (request.force || activeEphemeral);
  let stopped: StopComputeResult | undefined;
  try {
    if (!archive) throw archiveError;
    const evidence = archive;
    if (pending === undefined) await call("archive read", 3_000, (signal) => evidence.load(signal));
    attempt = await call("archive start", 3_000, (signal) => evidence.start(snapshot, request, d.now(), signal));
    if (shouldStop) {
      const stopStep = await stopCompute();
      steps.push(stopStep);
      if (stopStep.outcome === "failed") {
        deferSteps(["archive", "container", "steward", "worktree", "branch"], "compute stop failed");
        return finalize("error");
      }
    }
    let logs: string | undefined;
    if (primary.containerId) {
      const containerId = primary.containerId;
      const logSpan = span.startChild("brood.teardown.archive.logs");
      try {
        logs = await call("container logs", 4_000, () => d.readContainerLogs(containerId), false);
        logSpan.end();
      } catch (error) {
        const detail = message(error);
        warnings.push(`container logs unavailable: ${detail}`);
        logSpan.setAttributes({ "march.teardown.detail": detail });
        logSpan.end({ error: true });
      }
    } else if (primary.kind === "spawn") {
      warnings.push("container logs unavailable: no tracked container ID");
    }
    const evidenceWarnings: string[] = [];
    const current = store.get(primary.id) ?? primary;
    try {
      await call("archive evidence write", 3_000, (signal) =>
        archiveTeardownEvidence(dir, primary, logs, evidenceWarnings, current, signal));
    } finally {
      warnings.push(...evidenceWarnings);
    }
    steps.push({ step: "archive", outcome: "ok" });
  } catch (err) {
    steps.push({ step: "archive", outcome: "failed", detail: message(err) });
    warnings.push(`archive failed: ${message(err)}`);
  }

  const archiveStep = steps[steps.length - 1]!;
  endStepSpan(archiveSpan, archiveStep);

  if (archiveStep.outcome === "failed") {
    deferSteps(["container", "steward", "worktree", "branch"], "archive failed");
    return finalize("error");
  }

  // 2. Container.
  {
    const child = span.startChild("brood.teardown.container", {
      ...(spawn ? { "march.spawn.id": spawn.id } : {}),
    });
    try {
      const compute = resolveComputeTarget(primary);
      if (compute) {
        await call("container removal", 6_000, (signal) => {
          requireCurrentPrimary();
          return d.substrate.removeCompute(compute, stopped, signal);
        });
        steps.push({ step: "container", outcome: "ok", detail: "absence verified" });
      } else {
        steps.push({ step: "container", outcome: "skipped" });
      }
    } catch (err) {
      steps.push({ step: "container", outcome: "failed", detail: message(err) });
      warnings.push(`container removal failed: ${message(err)}`);
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  let stewardRemovalFailed = false;
  // 3. Verify Castra removal before reclaiming the shared worktree and branch.
  {
    const child = span.startChild("brood.teardown.steward", {
      ...(steward ? { "march.steward.id": steward.id } : {}),
    });
    if (groupStewards.length > 0) {
      const outcomes: TeardownStep[] = [];
      const stewardDeadline = Math.min(deadline - TEARDOWN_FINALIZATION_MS, performance.now() + 8_000);
      for (const row of groupStewards) {
        const outcome = await removeOneSteward(row, stewardDeadline);
        outcomes.push(outcome);
        if (outcome.outcome === "failed" && performance.now() >= stewardDeadline - 1) break;
      }
      const failedOutcomes = outcomes.filter((outcome) => outcome.outcome === "failed");
      if (failedOutcomes.length > 0) {
        stewardRemovalFailed = true;
        steps.push({
          step: "steward",
          outcome: "failed",
          detail: failedOutcomes.map((outcome) => outcome.detail).join("; ")
            .slice(0, TEARDOWN_DETAIL_LIMIT),
        });
      } else if (outcomes.length === 1) {
        steps.push(outcomes[0]!);
      } else {
        const removed = outcomes.filter((outcome) => outcome.outcome === "ok").length;
        steps.push({
          step: "steward",
          outcome: removed > 0 ? "ok" : "skipped",
          detail: `${outcomes.length} stewards verified gone (${removed} removed)`,
        });
      }
    } else {
      steps.push({ step: "steward", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  // A steward registered while earlier steps awaited shares the worktree but was
  // never removed. Check membership before each Git mutation.
  const unverifiedSteward = !stewardRemovalFailed && unremovedStewards(unchangedStewardIds(verifiedStewards));
  // Compute that may still be running (e.g. restarted after the stop check)
  // must keep its workspace; reclaim Git only after verified compute absence.
  const computeRemovalFailed = steps.some(
    (step) => step.step === "container" && step.outcome === "failed",
  );
  const gitDeferral = computeRemovalFailed
    ? "deferred: compute removal failed"
    : stewardRemovalFailed
    ? "deferred: steward removal failed"
    : unverifiedSteward
      ? "deferred: steward registered or changed during teardown"
      : undefined;

  let worktreeTimedOut = false;
  // 4. Worktree (re-check after steward; Castra may already have removed it).
  {
    const child = span.startChild("brood.teardown.worktree", {
      ...(primary.worktreePath
        ? { "march.worktree.path": primary.worktreePath }
        : {}),
    });
    if (gitDeferral) {
      steps.push({ step: "worktree", outcome: "skipped", detail: gitDeferral });
    } else if (primary.worktreePath && primary.repoPath) {
      try {
        const worktreePath = primary.worktreePath;
        const repoPath = primary.repoPath;
        const result = await call("worktree removal", 4_000, async (signal) => {
          const existed = await d.pathExists(worktreePath);
          if (!existed && deps.pathExists) return undefined;
          signal.throwIfAborted();
          requireCurrentPrimary();
          if (unremovedStewards(unchangedStewardIds(verifiedStewards))) {
            throw new Error("worktree removal deferred: steward registered or changed during teardown");
          }
          const removal = await d.substrate.removeWorkspace(repoPath, { worktreePath }, signal);
          return { ...removal, existed };
        });
        if (!result || (result.worktreeRemoved && !result.existed)) {
          steps.push({ step: "worktree", outcome: "skipped", detail: "already removed" });
        } else {
          if (!result.worktreeRemoved) {
            throw new Error(`worktree "${primary.worktreePath}" may still exist`);
          }
          steps.push({ step: "worktree", outcome: "ok" });
        }
      } catch (err) {
        worktreeTimedOut = err instanceof TeardownDeadlineError;
        const detail = message(err);
        steps.push({ step: "worktree", outcome: "failed", detail });
        warnings.push(detail);
      }
    } else {
      steps.push({ step: "worktree", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  // 5. Branch.
  {
    const child = span.startChild("brood.teardown.branch", {
      ...(primary.branch ? { "march.branch": primary.branch } : {}),
    });
    const branchDeferral = gitDeferral ??
      (worktreeTimedOut ? "deferred: worktree removal timed out" :
        unremovedStewards(unchangedStewardIds(verifiedStewards))
          ? "deferred: steward registered or changed during teardown" : undefined);
    if (branchDeferral) {
      steps.push({ step: "branch", outcome: "skipped", detail: branchDeferral });
    } else if (primary.branch && primary.repoPath) {
      try {
        const repoPath = primary.repoPath;
        const branch = primary.branch;
        const res = await call("branch deletion", 4_000, (signal) => {
          requireCurrentPrimary();
          return d.substrate.removeWorkspace(repoPath, { branch }, signal);
        });
        if (!res.branchDeleted) {
          throw new Error(`branch "${primary.branch}" may still exist`);
        }
        steps.push({ step: "branch", outcome: "ok" });
      } catch (err) {
        const detail = message(err);
        steps.push({ step: "branch", outcome: "failed", detail });
        warnings.push(detail);
      }
    } else {
      steps.push({ step: "branch", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  const failed = steps.some((step) => step.outcome === "failed");
  // Re-check after the Git steps' awaits: a registration that changed since
  // the pre-Git check (including a standalone steward primary) must not complete.
  const changedSteward = unverifiedSteward ||
    (!stewardRemovalFailed && unremovedStewards(unchangedStewardIds(verifiedStewards)));
  return finalize(
    stewardRemovalFailed ? "error" : failed || changedSteward ? "partial" : "success",
  );

  async function stopCompute(): Promise<TeardownStep> {
    const child = span.startChild("brood.teardown.stop");
    let step: TeardownStep;
    try {
      const compute = resolveComputeTarget(primary);
      if (!compute || !d.substrate.stopCompute) {
        throw new Error("Graceful stop is unsupported for this compute target");
      }
      const stop = d.substrate.stopCompute.bind(d.substrate);
      stopped = await call("compute stop", 10_000, (signal) => {
        requireCurrentPrimary();
        return stop(compute, signal);
      });
      step = stopped.outcome === "stopped"
        ? { step: "stop", outcome: "ok", detail: "graceful stop verified" }
        : {
          step: "stop", outcome: "skipped",
          detail: stopped.outcome === "absent" ? "already absent" : "already stopped",
        };
    } catch (err) {
      step = { step: "stop", outcome: "failed", detail: message(err) };
      warnings.push(`compute stop failed: ${step.detail}`);
    }
    endStepSpan(child, step);
    return step;
  }

  function deferSteps(deferredSteps: TeardownStep["step"][], reason: string): void {
    for (const step of deferredSteps) {
      const deferred: TeardownStep = { step, outcome: "skipped", detail: `deferred: ${reason}` };
      steps.push(deferred);
      endStepSpan(step === "archive" ? archiveSpan : span.startChild(`brood.teardown.${step}`), deferred);
    }
  }

  async function removeOneSteward(row: SessionRecord, stewardDeadline: number): Promise<TeardownStep> {
    const label = groupStewards.length > 1 ? ` (${row.id})` : "";
    try {
      const res = await teardownCall("steward removal", stewardDeadline, (signal) => {
        requireCurrentPrimary();
        if (!sameSteward(stewardIdentity(row), store.get(row.id))) {
          throw new Error("steward registration changed during teardown; retry teardown");
        }
        return d.removeSteward({
          sessionId: row.agentDeckSessionId ?? row.id,
          profile: row.profile,
          // The spawn (`primary`) carries the canonical worktree/branch the
          // steward shares; fall back to the steward row. Worktree is the
          // #155-safe match key Castra removal resolves the real id from (#304).
          worktreePath: primary.worktreePath ?? row.worktreePath,
          branch: primary.branch ?? row.branch,
        }, signal);
      }, key);
      if (res.outcome === "failed") {
        // Castra unreachable or the real session is still live — DEFER the
        // worktree/branch removal and leave the row retryable. Do NOT mark
        // torndown over an unconfirmed Castra removal (#304).
        const detail = (res.detail || "removal unconfirmed").slice(0, TEARDOWN_DETAIL_LIMIT);
        warnings.push(`steward removal failed${label}: ${detail}`);
        return { step: "steward", outcome: "failed", detail };
      }
      // `removed` — a real session was reaped; `absent` — Castra verified no
      // session for this worktree. Either way the steward is gone.
      verifiedStewards.push(stewardIdentity(row));
      return {
        step: "steward",
        outcome: res.outcome === "removed" ? "ok" : "skipped",
        detail: res.outcome === "removed"
          ? res.detail?.slice(0, TEARDOWN_DETAIL_LIMIT)
          : "already gone",
      };
    } catch (err) {
      warnings.push(`steward removal failed${label}: ${message(err)}`);
      return { step: "steward", outcome: "failed", detail: message(err) };
    }
  }

  /**
   * IDs of verified stewards whose current registration still matches what was
   * removed (same row, parent, and Castra target). A steward whose session
   * changed after removal was never verified gone, so it does not count.
   */
  function unchangedStewardIds(verified: readonly StewardIdentity[]): string[] {
    return verified
      .filter((recorded) => sameSteward(recorded, store.get(recorded.id)))
      .map((recorded) => recorded.id);
  }

  /** Warn about live stewards under the spawn that `verified` does not cover. */
  function unremovedStewards(verified: readonly string[]): boolean {
    // Only stewards currently under the spawn share its worktree; one that moved
    // to another spawn belongs to that group now. A standalone steward is its
    // own primary and must itself be verified unchanged before completion.
    const candidates = new Set(
      spawn
        ? store.list({ parentId: spawn.id, kind: "steward" }).map((row) => row.id)
        : primary.kind === "steward" ? [primary.id] : [],
    );
    const live = [...candidates].filter((stewardId) =>
      !verified.includes(stewardId) &&
      store.get(stewardId)?.status !== "torndown");
    for (const stewardId of live) {
      warnings.push(`steward "${stewardId}" was not removed by this teardown; retry teardown`);
    }
    return live.length > 0;
  }

  function completeRegistry(at: string, stewardIds: readonly string[]): void {
    const registrySpan = span.startChild("brood.teardown.registry");
    try {
      store.completeTeardown(primary.id, stewardIds, at);
      registrySpan.end();
    } catch (error) {
      registrySpan.end({ error: true });
      span.end({ error: true });
      throw error;
    }
  }

  async function finalize(outcome: "error" | "partial" | "success"): Promise<TeardownResult> {
    if (archive && attempt !== undefined) {
      const at = d.now();
      const finalizationSpan = span.startChild("brood.teardown.archive.finish");
      try {
        const evidence = archive;
        const attemptNumber = attempt;
        await teardownCall("archive finalization", Math.min(deadline, performance.now() + TEARDOWN_FINALIZATION_MS),
          (signal) => evidence.finish(attemptNumber, {
            id: primary.id,
            status: outcome === "success" ? "torndown" : "tearing-down",
            steps,
            warnings,
          }, at, { stewards: verifiedStewards, resources: teardownResources(primary) }, signal), key);
        finalizationSpan.end();
      } catch (error) {
        warnings.push(`archive finalization failed: ${message(error)}`);
        finalizationSpan.setAttributes({ "march.teardown.detail": message(error) });
        finalizationSpan.end({ error: true });
        return finish("error");
      }
      if (outcome === "success") {
        const verified = unchangedStewardIds(verifiedStewards);
        if (!primaryStillMatches()) {
          warnings.push("primary registration changed during teardown; retry teardown");
          return finish("partial");
        }
        if (unremovedStewards(verified)) {
          return finish("partial");
        }
        // Only acknowledge a terminal journal write that returned within the
        // deadline. A late filesystem rename cannot authorize recovery.
        store.prepareTeardownCompletion(primary.id, attempt);
        completeRegistry(at, verified);
      }
    }
    return finish(outcome);
  }

  function primaryStillMatches(): boolean {
    const current = store.get(primary.id);
    return current !== undefined && sameResources(teardownResources(primary), teardownResources(current)) &&
      (primary.kind !== "steward" || sameSteward(stewardIdentity(primary), current));
  }

  function requireCurrentPrimary(): void {
    if (!primaryStillMatches()) {
      throw new Error("primary registration changed during teardown; retry teardown");
    }
  }

  function finish(outcome: "error" | "partial" | "success"): TeardownResult {
    const finalStatus = outcome === "success" ? "torndown" : "tearing-down";
    for (const step of steps) {
      span.event(`teardown.${step.step}`, {
        outcome: step.outcome,
        ...(step.detail ? { detail: step.detail } : {}),
      });
    }
    span.setAttributes({ "march.teardown.outcome": outcome });
    span.end({ error: outcome !== "success" });
    recordBroodTeardown({
      kind: primary.kind,
      outcome,
      profile: steward?.profile ?? primary.profile ?? "unknown",
      durationSeconds: (Date.now() - startMs) / 1000,
    });

    return { id: primary.id, status: finalStatus, steps, warnings };
  }
}

function sameResources(recorded: TeardownResources | undefined, current: TeardownResources): boolean {
  return recorded !== undefined &&
    recorded.containerId === current.containerId &&
    recorded.repoPath === current.repoPath &&
    recorded.worktreePath === current.worktreePath &&
    recorded.branch === current.branch;
}

function snapshotRow(record: SessionRecord): SessionRecord {
  const { teardownReason, teardownRequiresForce, torndownAt, ...snapshot } = record;
  return snapshot;
}

function resolveComputeTarget(record: SessionRecord): ComputeTarget | undefined {
  // Spawn records can lack a log ID (for example, an interrupted launch).
  if (record.kind !== "spawn" && !record.containerId) return undefined;
  const containerName = record.kind === "spawn"
    ? spawnContainerName(record.id)
    : `march-${record.kind}-${record.id}`;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(record.id)) {
    throw new Error(`Invalid session identity for compute teardown: "${record.id}"`);
  }
  return { sessionId: record.id, kind: record.kind, containerName };
}

function rejectTeardown(
  span: BroodChildSpan,
  outcome: "not-found" | "conflict",
  error: Error,
): never {
  span.setAttributes({ "march.teardown.outcome": outcome });
  span.end({ error: true });
  throw error;
}

function message(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, TEARDOWN_DETAIL_LIMIT);
}

/** A response represents deferred cleanup as a skipped step with a reason. */
export function isDeferredTeardownStep(step: TeardownStep): boolean {
  return step.outcome === "skipped" && step.detail?.startsWith("deferred:") === true;
}

/**
 * Map a recorded teardown step to the child-span outcome vocabulary
 * (removed / not-found / deferred / failed). `deferred` marks a step held back
 * because an earlier step (steward removal) failed; `not-found` covers
 * nothing-to-reclaim / already-gone.
 */
function stepSpanOutcome(step: TeardownStep): string {
  if (step.outcome === "ok") {
    if (step.step === "stop") return "stopped";
    return step.step === "archive" ? "ok" : "removed";
  }
  if (step.outcome === "failed") return "failed";
  if (step.step === "stop" && step.detail === "already stopped") return "already-stopped";
  return isDeferredTeardownStep(step) ? "deferred" : "not-found";
}

/** Stamp a sub-step child span with its outcome (+detail) and end it. */
function endStepSpan(child: BroodChildSpan, step: TeardownStep): void {
  child.setAttributes({
    "march.teardown.step": step.step,
    "march.teardown.outcome": stepSpanOutcome(step),
    ...(step.detail ? { "march.teardown.detail": step.detail } : {}),
  });
  child.end({ error: step.outcome === "failed" || isDeferredTeardownStep(step) });
}
