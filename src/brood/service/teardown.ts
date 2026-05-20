import fs from "node:fs";
import path from "node:path";
import { recordBroodTeardown } from "../../observability/brood-metrics.js";
import { startBroodSpan } from "../../observability/brood-trace.js";
import {
  readSpawnContainerLogs,
  removeSpawnContainer,
} from "../../spawn/container-launch.js";
import {
  removeSpawnWorktreeExact,
  type RemoveWorktreeResult,
} from "../worktree.js";
import {
  removeStewardSession,
  type StewardRemoveResult,
} from "./castra-client.js";
import { broodArchiveDir, type SessionStore } from "./store.js";
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
  removeContainer?: (spawnId: string) => void;
  readContainerLogs?: (containerId: string) => string;
  removeSteward?: (input: {
    sessionId: string;
    profile?: string;
  }) => Promise<StewardRemoveResult>;
  removeWorktreeExact?: (
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ) => RemoveWorktreeResult;
  pathExists?: (p: string) => boolean;
  homeDir?: string;
  now?: () => string;
  /** Inbound W3C traceparent so the teardown span nests under the caller's trace. */
  traceparent?: string;
}

interface ResolvedDeps {
  removeContainer: (spawnId: string) => void;
  readContainerLogs: (containerId: string) => string;
  removeSteward: (input: {
    sessionId: string;
    profile?: string;
  }) => Promise<StewardRemoveResult>;
  removeWorktreeExact: (
    repoRoot: string,
    target: { worktreePath?: string; branch?: string },
  ) => RemoveWorktreeResult;
  pathExists: (p: string) => boolean;
  homeDir?: string;
  now: () => string;
}

function resolveDeps(deps: TeardownDeps): ResolvedDeps {
  return {
    removeContainer: deps.removeContainer ?? removeSpawnContainer,
    readContainerLogs: deps.readContainerLogs ?? readSpawnContainerLogs,
    removeSteward: deps.removeSteward ?? removeStewardSession,
    removeWorktreeExact: deps.removeWorktreeExact ?? removeSpawnWorktreeExact,
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
  store: SessionStore,
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
      ...(steward ? { "march.steward.id": steward.id } : {}),
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
  if (spawn) {
    try {
      d.removeContainer(spawn.id);
      steps.push({ step: "container", outcome: "ok" });
    } catch (err) {
      steps.push({ step: "container", outcome: "failed", detail: message(err) });
      warnings.push(`container removal failed: ${message(err)}`);
    }
  } else {
    steps.push({ step: "container", outcome: "skipped" });
  }

  // 3. Steward (await — castra may reclaim the shared worktree).
  if (steward) {
    try {
      const res = await d.removeSteward({
        sessionId: steward.agentDeckSessionId ?? steward.id,
        profile: steward.profile,
      });
      steps.push({
        step: "steward",
        outcome: res.removed ? "ok" : "skipped",
        detail: res.detail ?? `via ${res.via}`,
      });
    } catch (err) {
      steps.push({ step: "steward", outcome: "failed", detail: message(err) });
      warnings.push(`steward removal failed: ${message(err)}`);
    }
  } else {
    steps.push({ step: "steward", outcome: "skipped" });
  }

  // 4. Worktree (re-check after steward; castra may already have removed it).
  if (primary.worktreePath && primary.repoPath) {
    if (!d.pathExists(primary.worktreePath)) {
      steps.push({
        step: "worktree",
        outcome: "skipped",
        detail: "already removed",
      });
    } else {
      const res = d.removeWorktreeExact(primary.repoPath, {
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

  // 5. Branch.
  if (primary.branch && primary.repoPath) {
    const res = d.removeWorktreeExact(primary.repoPath, {
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

  // 6. Mark torndown (the JSON SpawnRecord is left on disk; "disposed" is
  //    derived from "registry torndown + artifacts gone").
  store.markTorndown(primary.id);
  if (steward && steward.id !== primary.id) {
    store.markTorndown(steward.id);
  }

  // Telemetry: one span per teardown (ordered step events), errored when any
  // step failed, plus the low-cardinality teardown metric.
  const failed = steps.some((step) => step.outcome === "failed");
  for (const step of steps) {
    span.event(`teardown.${step.step}`, {
      outcome: step.outcome,
      ...(step.detail ? { detail: step.detail } : {}),
    });
  }
  span.setAttributes({
    "march.teardown.outcome": failed ? "partial" : "success",
  });
  span.end({ error: failed });
  recordBroodTeardown({
    kind: primary.kind,
    outcome: failed ? "partial" : "success",
    profile: steward?.profile ?? primary.profile ?? "unknown",
    durationSeconds: (Date.now() - startMs) / 1000,
  });

  return { id: primary.id, status: "torndown", steps, warnings };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
