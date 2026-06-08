import fs from "node:fs";
import path from "node:path";
import { recordBroodTeardown } from "../../observability/brood-metrics.js";
import {
  startBroodSpan,
  type BroodChildSpan,
} from "../../observability/brood-trace.js";
import { readSpawnContainerLogs } from "../../spawn/container-launch.js";
import type { SessionRepository } from "./repository.js";
import {
  defaultStewardGateway,
  removeStewardViaCastra,
  type StewardRemovalResult,
} from "./steward-removal.js";
import { broodArchiveDir } from "./store.js";
import { hostTeardownSubstrate, type TeardownSubstrate } from "./substrate.js";
import type {
  SessionRecord,
  TeardownRequest,
  TeardownResult,
  TeardownStep,
} from "./types.js";

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
  readContainerLogs?: (containerId: string) => string;
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
  readContainerLogs: (containerId: string) => string;
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
    readContainerLogs: deps.readContainerLogs ?? readSpawnContainerLogs,
    removeSteward: deps.removeSteward ?? defaultRemoveSteward,
    pathExists: deps.pathExists ?? fs.existsSync,
    homeDir: deps.homeDir,
    now: deps.now ?? (() => new Date().toISOString()),
  };
}

/**
 * Tear down a managed session and reclaim its artifacts, in a fixed,
 * idempotent, best-effort order:
 *
 *   1. archive   — capture `docker logs` + a record snapshot before deletion.
 *   2. container — `docker rm -f` the spawn container.
 *   3. steward   — ask castra (or agent-deck) to remove the steward session,
 *                  awaiting completion. castra may reclaim the shared worktree.
 *   4. worktree  — re-check, then remove by EXACT path if still present.
 *   5. branch    — delete the spawn branch by exact name.
 *
 * The order matters for #155: the worktree is removed by exact tracked path
 * (never a blanket `git worktree prune`) and only after the steward — which
 * shares that worktree — has been torn down. A failing step records a warning
 * and the next step still runs. Tearing down an already-`torndown` session is a
 * no-op.
 */
export async function teardownSession(
  store: SessionRepository,
  id: string,
  request: TeardownRequest = {},
  deps: TeardownDeps = {},
): Promise<TeardownResult> {
  const d = resolveDeps(deps);
  const target = store.get(id);
  if (!target) {
    throw new BroodNotFoundError(`No session with id "${id}".`);
  }
  if (target.status === "torndown") {
    return { id: target.id, status: "torndown", steps: [], warnings: [] };
  }

  // Resolve the spawn<->steward group. The spawn row carries the canonical
  // container/worktree/branch; the steward row carries the agent-deck session.
  const spawn =
    target.kind === "spawn"
      ? target
      : target.parentId
        ? store.get(target.parentId)
        : undefined;
  const steward =
    target.kind === "steward"
      ? target
      : spawn
        ? store.list({ parentId: spawn.id, kind: "steward" })[0]
        : undefined;

  // `primary` owns the worktree/branch/container; fall back to the target row.
  const primary: SessionRecord = spawn ?? target;

  // Refuse to tear down a still-live spawn container without `force`.
  if (
    spawn &&
    (spawn.status === "running" || spawn.status === "created") &&
    !request.force
  ) {
    throw new BroodConflictError(
      `Spawn "${spawn.id}" is ${spawn.status}; pass force to tear it down.`,
    );
  }

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

  // Mark the group as tearing-down so a concurrent reader sees the transition.
  store.update(primary.id, {
    status: "tearing-down",
    ...(request.reason ? { failureReason: request.reason } : {}),
  });
  if (steward && steward.id !== primary.id) {
    store.update(steward.id, { status: "tearing-down" });
  }

  // 1. Archive (before any deletion).
  try {
    const dir = broodArchiveDir(primary.id, d.homeDir);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, "record.json"),
      JSON.stringify({ spawn, steward, torndownAt: d.now() }, null, 2) + "\n",
    );
    if (primary.containerId) {
      try {
        const logs = d.readContainerLogs(primary.containerId);
        fs.writeFileSync(path.join(dir, "container.log"), logs);
      } catch (err) {
        warnings.push(`container logs unavailable: ${message(err)}`);
      }
    }
    steps.push({ step: "archive", outcome: "ok" });
  } catch (err) {
    steps.push({ step: "archive", outcome: "failed", detail: message(err) });
    warnings.push(`archive failed: ${message(err)}`);
  }

  // 2. Container.
  {
    const child = span.startChild("brood.teardown.container", {
      ...(spawn ? { "march.spawn.id": spawn.id } : {}),
    });
    if (spawn) {
      try {
        d.substrate.removeSpawn(spawn.id);
        steps.push({ step: "container", outcome: "ok" });
      } catch (err) {
        steps.push({
          step: "container",
          outcome: "failed",
          detail: message(err),
        });
        warnings.push(`container removal failed: ${message(err)}`);
      }
    } else {
      steps.push({ step: "container", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  // 3. Steward (await — Castra owns the agent-deck session and may reclaim the
  //    shared worktree). If removal FAILS (e.g. Castra unreachable) we must NOT
  //    proceed to remove the worktree — that would pull the checkout out from
  //    under a still-live session. Defer the worktree/branch and retry next tick.
  let stewardRemovalFailed = false;
  {
    const child = span.startChild("brood.teardown.steward", {
      ...(steward ? { "march.steward.id": steward.id } : {}),
    });
    if (steward) {
      try {
        const res = await d.removeSteward({
          sessionId: steward.agentDeckSessionId ?? steward.id,
          profile: steward.profile,
          // The spawn (`primary`) carries the canonical worktree/branch the
          // steward shares; fall back to the steward row. Worktree is the
          // #155-safe match key Castra removal resolves the real id from (#304).
          worktreePath: primary.worktreePath ?? steward.worktreePath,
          branch: primary.branch ?? steward.branch,
        });
        if (res.outcome === "failed") {
          // Castra unreachable or the real session is still live — DEFER the
          // worktree/branch removal and leave the row retryable. Do NOT mark
          // torndown over an unconfirmed Castra removal (#304).
          stewardRemovalFailed = true;
          steps.push({ step: "steward", outcome: "failed", detail: res.detail });
          warnings.push(`steward removal failed: ${res.detail ?? "unconfirmed"}`);
        } else {
          // `removed` — a real session was reaped; `absent` — Castra verified no
          // session for this worktree. Either way the steward is gone, so it is
          // safe to reclaim the worktree and mark torndown.
          steps.push({
            step: "steward",
            outcome: res.outcome === "removed" ? "ok" : "skipped",
            detail: res.outcome === "removed" ? res.detail : "already gone",
          });
        }
      } catch (err) {
        stewardRemovalFailed = true;
        steps.push({ step: "steward", outcome: "failed", detail: message(err) });
        warnings.push(`steward removal failed: ${message(err)}`);
      }
    } else {
      steps.push({ step: "steward", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  // 4. Worktree (re-check after steward; Castra may already have removed it).
  {
    const child = span.startChild("brood.teardown.worktree", {
      ...(primary.worktreePath
        ? { "march.worktree.path": primary.worktreePath }
        : {}),
    });
    if (stewardRemovalFailed) {
      steps.push({
        step: "worktree",
        outcome: "skipped",
        detail: "deferred: steward removal failed",
      });
    } else if (primary.worktreePath && primary.repoPath) {
      if (!d.pathExists(primary.worktreePath)) {
        steps.push({
          step: "worktree",
          outcome: "skipped",
          detail: "already removed",
        });
      } else {
        const res = d.substrate.removeWorkspace(primary.repoPath, {
          worktreePath: primary.worktreePath,
        });
        if (res.worktreeRemoved) {
          steps.push({ step: "worktree", outcome: "ok" });
        } else {
          steps.push({ step: "worktree", outcome: "failed" });
          warnings.push(`worktree "${primary.worktreePath}" may still exist`);
        }
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
    if (stewardRemovalFailed) {
      steps.push({
        step: "branch",
        outcome: "skipped",
        detail: "deferred: steward removal failed",
      });
    } else if (primary.branch && primary.repoPath) {
      const res = d.substrate.removeWorkspace(primary.repoPath, {
        branch: primary.branch,
      });
      if (res.branchDeleted) {
        steps.push({ step: "branch", outcome: "ok" });
      } else {
        steps.push({ step: "branch", outcome: "failed" });
        warnings.push(`branch "${primary.branch}" may still exist`);
      }
    } else {
      steps.push({ step: "branch", outcome: "skipped" });
    }
    endStepSpan(child, steps[steps.length - 1]!);
  }

  // 6. Mark torndown — but only when the steward was actually removed. If it
  //    wasn't, leave the row "tearing-down" so the next teardown request retries
  //    (idempotent re-entry). The JSON SpawnRecord is left on disk; "disposed"
  //    is derived from "registry torndown + artifacts gone".
  if (!stewardRemovalFailed) {
    store.markTorndown(primary.id);
    if (steward && steward.id !== primary.id) {
      store.markTorndown(steward.id);
    }
  }

  // Telemetry: one span per teardown (ordered step events), errored when any
  // step failed, plus the low-cardinality teardown metric.
  const failed = steps.some((step) => step.outcome === "failed");
  const outcome: "success" | "partial" | "error" = stewardRemovalFailed
    ? "error"
    : failed
      ? "partial"
      : "success";
  const finalStatus = stewardRemovalFailed ? "tearing-down" : "torndown";
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

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Map a recorded teardown step to the child-span outcome vocabulary
 * (removed / not-found / deferred / failed). `deferred` marks a step held back
 * because an earlier step (steward removal) failed; `not-found` covers
 * nothing-to-reclaim / already-gone.
 */
function stepSpanOutcome(step: TeardownStep): string {
  if (step.outcome === "ok") return "removed";
  if (step.outcome === "failed") return "failed";
  return step.detail?.startsWith("deferred") ? "deferred" : "not-found";
}

/** Stamp a sub-step child span with its outcome (+detail) and end it. */
function endStepSpan(child: BroodChildSpan, step: TeardownStep): void {
  child.setAttributes({
    "march.teardown.step": step.step,
    "march.teardown.outcome": stepSpanOutcome(step),
    ...(step.detail ? { "march.teardown.detail": step.detail } : {}),
  });
  child.end({ error: step.outcome === "failed" });
}
