/**
 * @l1 @deterministic @ci
 *
 * Multi-tick integration for launch-failure classes (launch-failure recovery
 * plan, step 2): the legate's retry decision follows the structured class
 * Hatchery reports, not the error text.
 *
 * Drives the REAL coordinator pipeline with the REAL dispatch ops
 * (launch → complete → recover) against a world that keeps state across ticks:
 * git branches that persist (with or without unpushed commits), open PRs Herald
 * has observed, the default branch's artifact blobs, and a fake Hatchery that
 * fails per class UNTIL THE WORLD CHANGES. Each scenario asserts the outcome —
 * how many spawns were attempted and whether the next dispatch reached a steward
 * — never just that some function was called.
 */
import { describe, expect, it, vi } from "vitest";
import { runTick, type CoordinatorDeps } from "./coordinator.js";
import type { HandlerContext, LoopState } from "./state/types.js";
import {
  completePendingHatcheryDispatches,
  launchDispatch,
  recoverDispatch,
} from "./handlers/dispatch-ops.js";
import type { DispatchIoDeps } from "./handlers/dispatch-io.js";
import { dispatchSliceId } from "./pure/dispatch-id.js";
import { rebuildWorkingState } from "./state/sense.js";
import { foldEvents, type HeraldEvent } from "../../herald/events.js";
import type { LaunchFailure } from "../../hatchery/launch-failure.js";

const GROUP = "legate-workers";
const T0 = Date.parse("2026-11-27T00:00:00Z");
const TASKS = "specs/x/x.tasks.md";
const SPEC = "specs/x/x.spec.md";
const ITEM = {
  path: TASKS,
  parent_path: SPEC,
  next_action: { command: "smithy.forge", arguments: [TASKS, "1"] },
};
const SLICE = dispatchSliceId(ITEM);
const BRANCH = "feature/smithy/forge/x-us1-s1";

/** The stateful world the fake Hatchery and Herald read. */
interface World {
  raw: any;
  tick: number;
  /** Local git branches: unpushed commits on each. */
  branches: Map<string, string[]>;
  /** Open PRs Herald observed, by branch. */
  prs: Map<string, number>;
  /** Default-branch blob of each plan artifact. */
  blobs: Record<string, string>;
  /** Whether Herald has observed the open PR yet (adopt-from-fold reads it). */
  heraldSeesPr: boolean;
  /** Castra outage: every spawn fails with `castra_error`. */
  outage: boolean;
  /** The agent declines while the task file is at one of these blobs. */
  declineAt: Set<string>;
  jobs: Map<string, any>;
  spawns: any[];
  sessions: { id: string; status: string; group: string }[];
  emitted: any[];
  blobReads: number;
}

function makeWorld(over: Partial<World> = {}): World {
  return {
    raw: { slices: {}, archived_slices: {}, transient_retry_counts: {}, repo: { path: "/repo" } },
    tick: 0,
    branches: new Map(),
    prs: new Map(),
    blobs: { [TASKS]: "aaaaaaa1", [SPEC]: "bbbbbbb1" },
    heraldSeesPr: true,
    outage: false,
    declineAt: new Set(),
    jobs: new Map(),
    spawns: [],
    sessions: [],
    emitted: [],
    blobReads: 0,
    ...over,
  };
}

const nowIso = (world: World) => new Date(T0 + world.tick * 60 * 60 * 1000).toISOString();

/** The fake Hatchery's verdict on one spawn request, against the world NOW. */
function runSpawn(world: World, request: any): any {
  const fail = (message: string, failure: LaunchFailure) => ({ status: "failed", error: { message, failure } });
  if (world.outage) {
    return fail("Castra session launch failed: castra unreachable", { class: "castra_error", retry: "auto", reason: "castra_error" });
  }
  const pr = world.prs.get(BRANCH);
  if (pr !== undefined) {
    return fail(`branch '${BRANCH}' already exists`, {
      class: "branch_collision", retry: "adopt", reason: "branch_collision",
      evidence: { branch: BRANCH, verdict: "unsafe:open-pr", prNumbers: [pr] },
    });
  }
  const unpushed = world.branches.get(BRANCH);
  if (unpushed) {
    return fail(`branch '${BRANCH}' already exists\n\nOrphan branch ${BRANCH} was NOT auto-removed: unsafe to remove (diverged).`, {
      class: "branch_collision", retry: "operator", reason: "branch_collision",
      evidence: {
        branch: BRANCH, verdict: "unsafe:diverged", worktreePath: "/wt/x",
        commits: unpushed, commitCount: unpushed.length, touchedFileCount: 13,
      },
    });
  }
  if (world.declineAt.has(world.blobs[TASKS])) {
    return fail("Spawn 20261127-abcdef exited 3; manager prompt was not sent.", {
      class: "agent_declined", retry: "until_input_changes", reason: "agent_declined",
      evidence: {
        agentMessage: "Slice 1 is blocked until SD-001 is resolved.",
        artifacts: (request.artifactPaths ?? []).map((p: string) => ({ path: p, blob: world.blobs[p] ?? null })),
      },
    });
  }
  const sessionId = "steward-" + world.spawns.length;
  world.sessions.push({ id: sessionId, status: "running", group: GROUP });
  return {
    status: "succeeded",
    result: { spawnId: "spawn-" + world.spawns.length, managerSession: { sessionId, branch: BRANCH, worktreePath: "/wt/x" } },
  };
}

function ioDeps(world: World): DispatchIoDeps {
  return {
    meta: { profile: "march", worker_group: GROUP, repo: { path: "/repo" }, processor_name: "loop", paired_legate: "legate" },
    emitTransition: (e: any) => world.emitted.push(e),
    emit: () => {},
    log: () => {},
    postSpawn: async (request: any) => {
      world.spawns.push(request);
      const id = "job-" + world.spawns.length;
      world.jobs.set(id, runSpawn(world, request));
      return { id };
    },
    getJob: async (id: string) => world.jobs.get(id),
  };
}

function senseFrom(world: World): LoopState {
  const ts = nowIso(world);
  const pr = world.heraldSeesPr ? world.prs.get(BRANCH) : undefined;
  return {
    ts,
    statePresent: true,
    stateError: null,
    raw: world.raw,
    slices: world.raw.slices,
    archived: world.raw.archived_slices,
    repoPath: "/repo",
    workerGroup: GROUP,
    sessions: world.sessions,
    sessionsById: new Map(world.sessions.map((s) => [s.id, s])),
    workers: { waiting: 0, running: 0, idle: 0, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [ITEM], queue: { dispatchable: 1, blocked: 0, total: 0 } },
    // Herald's observation of the slice's branch (adopt-from-fold reads it).
    perSlice: pr !== undefined
      ? { [SLICE]: { pr: { number: pr, url: "u/" + pr, state: "OPEN" } } }
      : {},
  } as any;
}

function makeCtx(world: World): HandlerContext {
  return {
    meta: { profile: "march", worker_group: GROUP, processor_name: "loop", paired_legate: "legate", repo: { path: "/repo" } } as any,
    ts: nowIso(world),
    castra: {
      async launchSession() { throw new Error("no relaunch in this world"); },
      async sendPrompt() {},
      async removeSession() { return { removed: true }; },
      async recoverSessions() { return { recovered: [] }; },
    } as any,
    broodTeardown: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    broodRegister: vi.fn(async () => ({ ok: true, detail: "" })),
    broodRetire: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    emitTransition: (e: any) => world.emitted.push(e),
    emit: vi.fn(),
    log: vi.fn(),
  } as any;
}

function deps(world: World): CoordinatorDeps {
  const io = ioDeps(world);
  return {
    sense: async () => senseFrom(world),
    makeContext: () => makeCtx(world),
    babysit: { sendMessage: vi.fn(async () => {}), requestJudgement: vi.fn(async () => null) } as any,
    dispatch: {
      completePending: (state: any, ts: string) => completePendingHatcheryDispatches(state, ts, io),
      launchDispatch: (state: any, ts: string, item: any, sliceId: string) => launchDispatch(state, ts, item, sliceId, io),
      recoverDispatch: (state: any, ts: string, item: any, sliceId: string, attempt: number) =>
        recoverDispatch(state, ts, item, sliceId, attempt, io),
      requestJudgement: vi.fn(async () => null),
      artifactRevisions: async (paths: readonly string[]) => {
        world.blobReads++;
        return Object.fromEntries(paths.map((p) => [p, world.blobs[p] ?? null]));
      },
    },
    relaunch: { worktreeExists: () => true, ensureWorktree: async () => {} },
  };
}

/** Run one tick an hour after the last (so any backoff window can elapse). */
async function tick(world: World) {
  world.tick++;
  return runTick(deps(world));
}

async function ticks(world: World, n: number) {
  const outs = [];
  for (let i = 0; i < n; i++) outs.push(await tick(world));
  return outs;
}

const slice = (world: World) => world.raw.slices[SLICE];
const decision = (out: any) => out.results.dispatch.dispatchDecisions?.find((r: any) => r.sliceId === SLICE)?.decision;

/** Cold-start rebuild of the working state from the events the legate emitted. */
function restart(world: World): void {
  const events = world.emitted.map((e, i) => ({
    seq: i + 1, id: "e" + (i + 1), ts: nowIso(world), source: "legate", profile: "march", ...e,
  })) as HeraldEvent[];
  world.raw = rebuildWorkingState(foldEvents(events), { repo: { path: "/repo" } } as any);
}

describe("launch-failure classes — multi-tick", () => {
  it("outage: retried with backoff, then the world heals and the dispatch reaches a steward", async () => {
    const world = makeWorld({ outage: true });
    await ticks(world, 4);
    // Every failure was classed an outage and the loop kept re-dispatching it.
    expect(world.emitted.filter((e) => e.type === "slice.escalated" && e.failure?.class === "castra_error").length)
      .toBeGreaterThanOrEqual(2);
    const attemptsDuringOutage = world.spawns.length;
    expect(attemptsDuringOutage).toBeGreaterThanOrEqual(2);

    world.outage = false;
    // Backoff doubles per failure; a few hourly ticks always clear it.
    for (let i = 0; i < 6 && slice(world)?.stage !== "implementing"; i++) await tick(world);
    expect(slice(world).stage).toBe("implementing");
    expect(slice(world).worker_session_id).toMatch(/^steward-/);
    expect(world.spawns.length).toBeGreaterThan(attemptsDuringOutage);
  });

  it("unpushed-commit collision: never re-dispatched, held with the SHAs, then succeeds once the branch is gone", async () => {
    const shas = ["ada24ade" + "0".repeat(32)];
    const world = makeWorld({ branches: new Map([[BRANCH, shas]]) });
    const outs = await ticks(world, 8);

    // One spawn (the first dispatch), never another over 8 ticks.
    expect(world.spawns).toHaveLength(1);
    expect(slice(world)).toMatchObject({
      stage: "escalated",
      escalated_reason: "hatchery_dispatch_failed",
      launch_failure: { class: "branch_collision", retry: "operator", evidence: { commits: shas, touchedFileCount: 13 } },
    });
    expect(decision(outs.at(-1))).toBe("held_operator");
    // The escalation detail the console reads today still works.
    expect(slice(world).last_action_note).toMatch(/^NEED: Hatchery dispatch failed: .*already exists/s);
    // The class is durable: it rode on slice.escalated.
    expect(world.emitted).toContainEqual(expect.objectContaining({
      type: "slice.escalated", sliceId: SLICE, failure: expect.objectContaining({ retry: "operator" }),
    }));

    // The operator requeues: the branch is removed and the slice tombstoned.
    world.branches.delete(BRANCH);
    world.emitted.push({ type: "slice.recovery.requested", sliceId: SLICE, rung: 3 });
    delete world.raw.slices[SLICE];

    await tick(world);
    expect(world.spawns).toHaveLength(2);
    await tick(world);
    expect(slice(world).stage).toBe("implementing");
  });

  it("agent_declined: held while the plan is unchanged, one re-dispatch per change, held again on a second decline", async () => {
    const world = makeWorld();
    world.declineAt = new Set(["aaaaaaa1", "aaaaaaa2"]); // gate unresolved in both revisions
    const outs = await ticks(world, 6);

    expect(world.spawns).toHaveLength(1);
    expect(world.spawns[0].artifactPaths).toEqual([TASKS, SPEC]);
    expect(slice(world).launch_failure).toMatchObject({
      class: "agent_declined", retry: "until_input_changes",
      evidence: {
        agentMessage: expect.stringContaining("SD-001"),
        artifacts: [{ path: TASKS, blob: "aaaaaaa1" }, { path: SPEC, blob: "bbbbbbb1" }],
      },
    });
    expect(decision(outs.at(-1))).toBe("held_until_input_changes");
    // The hold reads the default branch once per tick, not once per artifact.
    expect(world.blobReads).toBe(5);

    // The task file changes on the default branch → exactly one re-dispatch.
    world.blobs[TASKS] = "aaaaaaa2";
    await ticks(world, 5);
    expect(world.spawns).toHaveLength(2);
    // It declined again at the NEW blob, so it holds there.
    expect(slice(world).launch_failure.evidence.artifacts[0]).toEqual({ path: TASKS, blob: "aaaaaaa2" });

    // The gate is resolved (the agent builds at this revision) → one more dispatch that succeeds.
    world.blobs[TASKS] = "aaaaaaa3";
    await ticks(world, 2);
    expect(world.spawns).toHaveLength(3);
    expect(slice(world).stage).toBe("implementing");
  });

  it("open-PR collision: held (not re-spawned) until Herald observes the PR, then adopted", async () => {
    const world = makeWorld({ heraldSeesPr: false });
    world.prs.set(BRANCH, 512);
    const outs = await ticks(world, 4);
    expect(world.spawns).toHaveLength(1);
    expect(slice(world)).toMatchObject({
      stage: "escalated", launch_failure: { retry: "adopt", evidence: { prNumbers: [512] } },
    });
    expect(decision(outs.at(-1))).toBe("held_adopt");

    // Herald observes the PR → adopt-from-fold adopts it; still no new spawn.
    world.heraldSeesPr = true;
    await ticks(world, 3);
    expect(slice(world).stage).toBe("pr-open");
    expect(slice(world).launch_failure).toBeUndefined();
    expect(world.spawns).toHaveLength(1);
  });

  it("restart mid-hold: the class and the hold survive the rebuild (no retry storm)", async () => {
    const world = makeWorld({ branches: new Map([[BRANCH, ["ada24ade" + "0".repeat(32)]]]) });
    await ticks(world, 3);
    expect(world.spawns).toHaveLength(1);

    restart(world);
    expect(slice(world)).toMatchObject({
      stage: "escalated",
      escalated_reason: "hatchery_dispatch_failed",
      launch_failure: { class: "branch_collision", retry: "operator" },
    });
    const outs = await ticks(world, 6);
    expect(world.spawns).toHaveLength(1);
    expect(decision(outs.at(-1))).toBe("held_operator");
  });

  it("restart mid-agent_declined hold: still held, and still re-arms on a plan change", async () => {
    const world = makeWorld();
    world.declineAt = new Set(["aaaaaaa1"]);
    await ticks(world, 3);
    expect(world.spawns).toHaveLength(1);

    restart(world);
    await ticks(world, 4);
    expect(world.spawns).toHaveLength(1);

    world.blobs[TASKS] = "aaaaaaa2";
    await ticks(world, 2);
    expect(world.spawns).toHaveLength(2);
    expect(slice(world).stage).toBe("implementing");
  });
});
