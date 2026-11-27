/**
 * @l1 @deterministic @ci
 *
 * Multi-tick integration for the cut steering gate (launch-failure recovery
 * plan, step 1). A cut PR that gates a slice on an unresolved decision must not
 * auto-merge until a human answers, even under `byTaskType.cut.approval: false`.
 *
 * The world holds state across ticks: a fake GitHub (PRs with labels, merges)
 * that Hatchery's real publisher writes to and the legate's merge seam merges
 * in, observed each tick the way Herald does (`labelsNeedSteering` on the
 * `gh pr view --json labels` value). The coordinator pipeline is the real one.
 * Assertions are on outcomes: whether the PR merged, and what the legate
 * reports as the blocker.
 */
import { describe, expect, it, vi } from "vitest";
import { runTick, type CoordinatorDeps } from "./coordinator.js";
import type { HandlerContext, LoopState } from "./state/types.js";
import { buildPullRequestMetadata, openOrReusePullRequest } from "../../hatchery/pr-publisher.js";
import { steeringQuestionsFrom } from "../../hatchery/spawn-handoff.js";
import { labelsNeedSteering, NEEDS_STEERING_LABEL } from "../../shared/steering.js";

const NOW = "2026-11-19T00:00:00Z";
const GROUP = "legate-workers";
const REPO = "example/march";
const SLICE = "tessera-credential-entitlement-service-us3-cut";
const BRANCH = "feature/smithy/cut/tessera-credential-entitlement-service-us3";
const COMMIT = {
  spawnId: "20261119-620cut", branch: BRANCH, commitSha: "c".repeat(40),
  patchSha256: "d".repeat(64), committedAt: NOW,
};

// The #620 task file declared the gate in improvised prose; its steward knew.
const TASK_FILE_620 = [
  "## Slice 1: Isolate and Rotate Provider Secrets",
  "Slice 1 must not be forged until SD-001 and SD-006 are both resolved.",
].join("\n");

/** What a steward following the new instructions prints for the #620 cut. */
const STEWARD_OUTPUT_620 = [
  "Reviewed the cut. The task file gates slice 1:",
  `> ${TASK_FILE_620.split("\n")[1]}`,
  "STEERING: SD-001 where do provider secrets live? Options: Tessera only (one audited store) / per-service vaults (blast radius per service). Blocks: slice 1",
  "STEERING: SD-006 rotation ownership? Options: Tessera rotates / each provider rotates. Blocks: slice 1",
  "REVIEW r-620 steering",
  "NEED: SD-001 and SD-006 need a human decision — answer in this session and I will apply it.",
].join("\n");

/** A cut whose spec carries ordinary debt but no gate. */
const STEWARD_OUTPUT_DEBT_ONLY = [
  "Reviewed the cut. SD-002 (log retention) stays open as spec debt; no slice is gated on it.",
  "REVIEW r-debt passed",
].join("\n");

interface FakePr { number: number; state: "OPEN" | "MERGED"; labels: { name: string }[]; headSha: string }

interface World {
  raw: any;
  sessions: { id: string; status: string; group: string }[];
  github: { prs: FakePr[] };
}

/** A stateful GitHub REST fake covering what the publisher calls. */
function githubFetch(world: World): typeof fetch {
  return (async (input: any, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.slice(`/repos/${REPO}`.length);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const pull = (pr: FakePr) => ({
      number: pr.number, state: pr.state === "OPEN" ? "open" : "closed",
      html_url: `https://github.com/${REPO}/pull/${pr.number}`,
      head: { ref: BRANCH, sha: pr.headSha, repo: { full_name: REPO } },
      base: { ref: "main", repo: { full_name: REPO } },
    });
    if (path === "/pulls" && init?.method === "POST") {
      const pr: FakePr = { number: 620, state: "OPEN", labels: [], headSha: COMMIT.commitSha };
      world.github.prs.push(pr);
      return Response.json(pull(pr), { status: 201 });
    }
    if (path === "/pulls") return Response.json(world.github.prs.filter((p) => p.state === "OPEN").map(pull));
    if (path === "") return Response.json({ default_branch: "main" });
    if (path === "/branches/main") return Response.json({ name: "main" });
    if (path === "/labels") return Response.json({ name: body.name }, { status: 201 });
    const labels = /^\/issues\/(\d+)\/labels$/.exec(path);
    if (labels) {
      const pr = world.github.prs.find((p) => p.number === Number(labels[1]))!;
      pr.labels.push(...body.labels.map((name: string) => ({ name })));
      return Response.json(pr.labels);
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
}

/** Hatchery publication of the cut from its steward's review output. */
async function publish(world: World, stewardOutput: string): Promise<void> {
  const verification = /^REVIEW \S+ (passed|steering)$/m.exec(stewardOutput)![1] as "passed" | "steering";
  const metadata = buildPullRequestMetadata({
    commit: COMMIT, backend: "codex", touchedPaths: ["specs/tessera/us3.tasks.md"], verification,
    ...(verification === "steering" && { steeringQuestions: steeringQuestionsFrom(stewardOutput) }),
  });
  const result = await openOrReusePullRequest(
    { repository: REPO, commit: COMMIT, baseBranch: "main", metadata: async () => metadata },
    { token: async () => "t", fetch: githubFetch(world) },
  );
  expect(result.status).toBe("succeeded");
}

function makeWorld(): World {
  return {
    raw: {
      slices: {
        [SLICE]: {
          stage: "pr-open", command: "smithy.cut", worker_session_id: "w", branch: BRANCH,
          worktree_path: "/wt/cut", pr: { number: 620, url: "u", state: "OPEN" },
        },
      },
      archived_slices: {}, transient_retry_counts: {}, castra_recover_attempts: {}, repo: { path: "/repo" },
    },
    sessions: [{ id: "w", status: "idle", group: GROUP }],
    github: { prs: [] },
  };
}

/** Herald's observation of the live PR: green, mergeable, clean, unapproved. */
function observePr(world: World): any {
  const pr = world.github.prs.find((p) => p.number === 620)!;
  return {
    number: pr.number, url: `https://github.com/${REPO}/pull/${pr.number}`, state: pr.state,
    mergeable: "MERGEABLE", checks: "NONE", needs_response_count: 0, thread_count: 0,
    head_branch: BRANCH, head_sha: pr.headSha, merge_state_status: "clean",
    human_approval_count: 0, changes_requested_count: 0, conversation_comments: [],
    needs_steering: labelsNeedSteering(pr.labels),
  };
}

function senseFrom(world: World): LoopState {
  return {
    ts: NOW, statePresent: true, stateError: null, raw: world.raw,
    slices: world.raw.slices, archived: world.raw.archived_slices, repoPath: "/repo", workerGroup: GROUP,
    sessions: world.sessions, sessionsById: new Map(world.sessions.map((s) => [s.id, s])),
    workers: { waiting: 0, running: 0, idle: 1, error: 0, stopped: 0, other: 0 },
    smithy: { ok: true, ready: [], queue: { dispatchable: 0, blocked: 0, total: 0 } },
    // The steward finished normally (as #620's did): its self-report is no gate.
    perSlice: { [SLICE]: { recentOutput: { output: "" }, pr: observePr(world), stewardReport: { status: "working", classified: true } } },
    // March's live policy: cuts auto-merge without approval.
    mergePolicy: { byTaskType: { cut: { approval: false } } },
  } as LoopState;
}

function makeDeps(world: World) {
  const mergePr = vi.fn(async ({ prNumber }: { prNumber: number }) => {
    world.github.prs.find((p) => p.number === prNumber)!.state = "MERGED";
    return { merged: true, mergeSha: "e".repeat(40) };
  });
  const ctx = {
    meta: { profile: "march", worker_group: GROUP, processor_name: "loop", paired_legate: "legate" },
    ts: NOW,
    castra: { async sendPrompt() {}, async removeSession() { return { removed: true }; } },
    broodTeardown: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    broodRegister: vi.fn(async () => ({ ok: true, detail: "" })),
    broodRetire: vi.fn(async () => ({ ok: true, notTracked: false, detail: "" })),
    emitTransition: vi.fn(),
    emit: vi.fn(),
    log: vi.fn(),
  } as unknown as HandlerContext;
  const deps: CoordinatorDeps = {
    sense: async () => senseFrom(world),
    makeContext: () => ctx,
    babysit: { sendMessage: vi.fn(async () => {}), requestJudgement: vi.fn(async () => null), mergePr } as any,
    dispatch: {
      completePending: vi.fn(async () => ({ actions: [], failures: [], mutated: false, notifications: [] })),
      launchDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      recoverDispatch: vi.fn(async () => ({ actions: [], failures: [], mutated: false })),
      requestJudgement: vi.fn(async () => null),
    } as any,
    relaunch: { worktreeExists: () => true, ensureWorktree: async () => {} },
  };
  return { deps, mergePr };
}

const babysitActions = (out: any): string[] => out.results.babysit.actions.map((a: any) => a.action);
const merged = (world: World) => world.github.prs.find((p) => p.number === 620)?.state === "MERGED";

describe("cut steering gate — multi-tick", () => {
  it("the #620 cut is held, not merged, while its steering question is open; removing the label merges it", async () => {
    const world = makeWorld();
    await publish(world, STEWARD_OUTPUT_620);
    expect(world.github.prs[0].labels).toEqual([{ name: NEEDS_STEERING_LABEL }]);
    const { deps, mergePr } = makeDeps(world);

    const actions: string[] = [];
    for (let tick = 0; tick < 5; tick++) {
      const out = await runTick(deps);
      actions.push(...babysitActions(out));
      // The pr_blocker{reason="needs_steering"} gauge reads this tally.
      expect(out.tick.prBlockerCounts.needs_steering).toBe(1);
      expect(out.tick.waitingOnApprovalCount).toBe(1);
    }
    expect(mergePr).not.toHaveBeenCalled();
    expect(merged(world)).toBe(false);
    expect(world.raw.slices[SLICE]).toMatchObject({ stage: "pr-open", pr_blocker: "needs_steering", merge_gate: "waiting-approval" });
    // The hold is recorded once per head, not every tick.
    expect(actions.filter((a) => a === "pr-steering-hold")).toHaveLength(1);
    expect(actions).not.toContain("pr-auto-merge");

    // The human answers; the steward applies it and removes the label.
    world.github.prs[0].labels = [];
    const out = await runTick(deps);
    expect(babysitActions(out)).toContain("pr-auto-merge");
    expect(merged(world)).toBe(true);
    expect(world.raw.slices[SLICE].stage).toBe("merged");
  });

  it("control: a cut with spec debt but no gate merges on the first tick, as today", async () => {
    const world = makeWorld();
    await publish(world, STEWARD_OUTPUT_DEBT_ONLY);
    expect(world.github.prs[0].labels).toEqual([]);
    const { deps, mergePr } = makeDeps(world);

    const out = await runTick(deps);
    expect(babysitActions(out)).toContain("pr-auto-merge");
    expect(mergePr).toHaveBeenCalledTimes(1);
    expect(merged(world)).toBe(true);
  });
});
