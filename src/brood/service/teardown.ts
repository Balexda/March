import fs from "node:fs";
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
  }) => Promise<StewardRemovalResult>;
  pathExists?: (p: string) => boolean;
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
  }) => Promise<StewardRemovalResult>;
  pathExists: (p: string) => boolean;
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
}): Promise<StewardRemovalResult> {
  return removeStewardViaCastra(defaultStewardGateway(), input);
}

function resolveDeps(deps: TeardownDeps): ResolvedDeps {
  return {
    substrate: deps.substrate ?? hostTeardownSubstrate,
    readContainerLogs: deps.readContainerLogs ?? readContainerLogsAsync,
    removeSteward: deps.removeSteward ?? defaultRemoveSteward,
    pathExists: deps.pathExists ?? fs.existsSync,
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
  // Serialize requests for the same archive, including requests by steward ID.
  // Re-resolve the key after each wait: a queued steward can be re-registered
  // under another spawn while it waits, and must then queue on that archive.
  for (;;) {
    const key = archiveKey(store, id, deps.homeDir);
    const previous = activeTeardowns.get(key);
    if (previous) {
      await previous.catch(() => undefined);
      continue;
    }
    const current = runTeardown(store, id, request, deps);
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
  // Prefer a live steward so a spawn-addressed retry never treats the group as
  // complete while a later steward still runs.
  const steward =
    target.kind === "steward"
      ? target
      : stewards.find((candidate) => candidate.status !== "torndown") ?? stewards[0];
  // Every steward sharing the spawn's worktree must be verified gone before Git
  // cleanup or a terminal result; the selected steward leads the list.
  const groupStewards = steward
    ? [steward, ...stewards.filter((row) => row.id !== steward.id && row.status !== "torndown")]
    : [];
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

  if (primary.status === "torndown" && (!steward || steward.status === "torndown")) {
    return finish("success");
  }

  const dir = path.resolve(broodArchiveDir(primary.id, d.homeDir));
  let archive: TeardownArchive | undefined;
  let archiveError: unknown;
  try {
    if (path.dirname(dir) !== path.resolve(broodArchiveDir("", d.homeDir)) ||
        path.basename(dir) !== primary.id) {
      throw new Error("Invalid session identity for teardown archive");
    }
    archive = new TeardownArchive(dir);
  } catch (error) {
    archiveError = error;
  }
  const completion = archive?.completion;
  const recoveredStewards = completion ? unchangedStewardIds(completion.stewards ?? []) : [];
  // A standalone steward is its own primary: recover it only while its
  // registration still matches the removed session; otherwise tear down anew.
  const primaryUnchanged = primary.kind !== "steward" || recoveredStewards.includes(primary.id);
  if (completion && completion.attempt === store.pendingTeardownCompletion(primary.id) &&
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
    attempt = archive.start(snapshot, request, d.now());
    if (shouldStop) {
      const stopStep = await stopCompute();
      steps.push(stopStep);
      if (stopStep.outcome === "failed") {
        deferSteps(["archive", "container", "steward", "worktree", "branch"], "compute stop failed");
        return finalize("error");
      }
    }
    await archiveTeardownEvidence(
      dir,
      primary,
      d.readContainerLogs,
      warnings,
      // Read the result after the async log read so a result committed before
      // teardown began is archived; later result writes are rejected.
      () => store.get(primary.id) ?? primary,
    );
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
        if (stopped) await d.substrate.removeCompute(compute, stopped);
        else await d.substrate.removeCompute(compute);
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
      for (const row of groupStewards) outcomes.push(await removeOneSteward(row));
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
  // never removed. Check membership here, synchronously adjacent to the Git
  // steps (no await in between), and defer both rather than delete its workspace.
  const unverifiedSteward = !stewardRemovalFailed && unremovedStewards(unchangedStewardIds(verifiedStewards));
  const gitDeferral = stewardRemovalFailed
    ? "deferred: steward removal failed"
    : unverifiedSteward
      ? "deferred: steward registered or changed during teardown"
      : undefined;

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
        if (!d.pathExists(primary.worktreePath)) {
          steps.push({ step: "worktree", outcome: "skipped", detail: "already removed" });
        } else {
          const res = d.substrate.removeWorkspace(primary.repoPath, {
            worktreePath: primary.worktreePath,
          });
          if (!res.worktreeRemoved) {
            throw new Error(`worktree "${primary.worktreePath}" may still exist`);
          }
          steps.push({ step: "worktree", outcome: "ok" });
        }
      } catch (err) {
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
    if (gitDeferral) {
      steps.push({ step: "branch", outcome: "skipped", detail: gitDeferral });
    } else if (primary.branch && primary.repoPath) {
      try {
        const res = d.substrate.removeWorkspace(primary.repoPath, {
          branch: primary.branch,
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
      stopped = await d.substrate.stopCompute(compute);
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

  async function removeOneSteward(row: SessionRecord): Promise<TeardownStep> {
    const label = groupStewards.length > 1 ? ` (${row.id})` : "";
    try {
      const res = await d.removeSteward({
        sessionId: row.agentDeckSessionId ?? row.id,
        profile: row.profile,
        // The spawn (`primary`) carries the canonical worktree/branch the
        // steward shares; fall back to the steward row. Worktree is the
        // #155-safe match key Castra removal resolves the real id from (#304).
        worktreePath: primary.worktreePath ?? row.worktreePath,
        branch: primary.branch ?? row.branch,
      });
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

  function finalize(outcome: "error" | "partial" | "success"): TeardownResult {
    if (archive && attempt !== undefined) {
      const at = d.now();
      const finalizationSpan = span.startChild("brood.teardown.archive.finish");
      try {
        if (outcome === "success") store.prepareTeardownCompletion(primary.id, attempt);
        archive.finish(attempt, {
          id: primary.id,
          status: outcome === "success" ? "torndown" : "tearing-down",
          steps,
          warnings,
        }, at, { stewards: verifiedStewards, resources: teardownResources(primary) });
        finalizationSpan.end();
      } catch (error) {
        warnings.push(`archive finalization failed: ${message(error)}`);
        finalizationSpan.end({ error: true });
        return finish("error");
      }
      if (outcome === "success") completeRegistry(at, unchangedStewardIds(verifiedStewards));
    }
    return finish(outcome);
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
