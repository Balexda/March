/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  alreadyArchivedSlice,
  blockingMergedArchive,
  classifyReady,
  findArchiveBlocker,
  findLiveBlocker,
  createSpawnBudget,
  DISPATCH_RECOVERY_LIMIT,
  dispatchableReady,
  escalatedRecoverable,
  inFlightSliceMatches,
  isReadyToMerge,
  isStubArchivedSlice,
  isTerminalSlice,
  liveSpawnCount,
  recoverableEscalations,
  recoveryAttemptKey,
  recoveryBudgetExhausted,
  scheduleDispatchRecoveryBackoff,
  clearDispatchRecoveryBackoff,
  decreaseDispatchRecoveryRate,
  increaseDispatchRecoveryRate,
  DISPATCH_RECOVERY_RATE_FIELD,
  DISPATCH_RECOVERY_BACKOFF_FIELD,
  sliceReleasesArtifact,
  summarizeSlicesByStage,
  countStrandedSlices,
  mergeReadiness,
  mergeBlocker,
} from "./slice.js";
import { dispatchSliceId } from "./dispatch-id.js";

const item = {
  path: "docs/x.tasks.md",
  next_action: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"] },
};
// branch/key the matchers compute for `item`:
const ITEM_BRANCH = "smithy/forge/docs-x-tasks-md-forge"; // legacy-hash path may vary; not asserted directly

describe("spawn cap helpers (#313)", () => {
  it("liveSpawnCount counts only non-terminal slices (pipeline-occupying spawns)", () => {
    const slices = {
      a: { stage: "hatchery-pending" },
      b: { stage: "implementing" },
      c: { stage: "pr-open" },
      d: { stage: "pr-in-fix" },
      e: { stage: "pr-resolving-conflicts" },
      // terminal — must NOT count:
      f: { stage: "merged" },
      g: { stage: "escalated" },
      h: { pr: { state: "CLOSED" } },
      i: { pr: { state: "MERGED" } },
    };
    expect(liveSpawnCount({ slices })).toBe(5);
  });

  it("liveSpawnCount is 0 for empty/missing state", () => {
    expect(liveSpawnCount({ slices: {} })).toBe(0);
    expect(liveSpawnCount({})).toBe(0);
    expect(liveSpawnCount(null)).toBe(0);
  });

  it("liveSpawnCount excludes waiting-to-merge but counts active stewards", () => {
    const slices = {
      // active spawn + active steward → count
      spawn: { stage: "implementing" },
      stewardOwed: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 2 },
      stewardConflict: { stage: "pr-open", pr: { checks: "PASS", mergeable: "CONFLICTING" }, needs_response_count: 0 },
      stewardChecks: { stage: "pr-open", pr: { checks: "FAIL", mergeable: "MERGEABLE" }, needs_response_count: 0 },
      // waiting for merge (all-clear) → does NOT count
      waiting: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 0 },
      // unknown thread debt (e.g. post-cold-start) is treated as active → counts
      unknownDebt: { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" } },
    };
    // spawn + 3 stewards + unknownDebt = 5; only `waiting` is released.
    expect(liveSpawnCount({ slices })).toBe(5);
  });

  it("isReadyToMerge matches the dashboard's waiting-for-merge gate", () => {
    const clear = { stage: "pr-open", pr: { checks: "PASS", mergeable: "MERGEABLE" }, needs_response_count: 0 };
    expect(isReadyToMerge(clear)).toBe(true);
    expect(isReadyToMerge({ ...clear, pr: { checks: "NONE", mergeable: "MERGEABLE" } })).toBe(true);
    expect(isReadyToMerge({ ...clear, stage: "implementing" })).toBe(false); // not pr-open
    expect(isReadyToMerge({ ...clear, pr: { checks: "FAIL", mergeable: "MERGEABLE" } })).toBe(false); // checks
    expect(isReadyToMerge({ ...clear, pr: { checks: "PASS", mergeable: "CONFLICTING" } })).toBe(false); // conflict
    expect(isReadyToMerge({ ...clear, needs_response_count: 1 })).toBe(false); // threads owed
    expect(isReadyToMerge({ stage: "pr-open", pr: { checks: "PASS" } })).toBe(false); // unknown debt → not ready
    expect(isReadyToMerge(null)).toBe(false);
  });

  it("createSpawnBudget seeds remaining = max(0, cap − live) and retains cap/live", () => {
    expect(createSpawnBudget(10, 0)).toEqual({ cap: 10, live: 0, remaining: 10, deferred: 0 });
    expect(createSpawnBudget(10, 7)).toEqual({ cap: 10, live: 7, remaining: 3, deferred: 0 });
    // live ≥ cap → fully throttled, never negative.
    expect(createSpawnBudget(10, 10)).toEqual({ cap: 10, live: 10, remaining: 0, deferred: 0 });
    expect(createSpawnBudget(10, 14)).toEqual({ cap: 10, live: 14, remaining: 0, deferred: 0 });
  });
});

describe("slice pure helpers", () => {
  it("isTerminalSlice covers merged/escalated stages + terminal PR states", () => {
    expect(isTerminalSlice({ stage: "merged" })).toBe(true);
    expect(isTerminalSlice({ stage: "escalated" })).toBe(true);
    expect(isTerminalSlice({ pr: { state: "CLOSED" } })).toBe(true);
    expect(isTerminalSlice({ stage: "implementing" })).toBe(false);
    expect(isTerminalSlice(null)).toBe(true);
  });

  it("sliceReleasesArtifact is true only for MERGED (not escalated/closed)", () => {
    expect(sliceReleasesArtifact({ stage: "merged" })).toBe(true);
    expect(sliceReleasesArtifact({ pr: { state: "MERGED" } })).toBe(true);
    expect(sliceReleasesArtifact({ stage: "escalated" })).toBe(false);
    expect(sliceReleasesArtifact({ pr: { state: "CLOSED" } })).toBe(false);
  });

  it("treats command-less, branch-less archive entries as stubs", () => {
    expect(isStubArchivedSlice({})).toBe(true);
    expect(isStubArchivedSlice({ command: "smithy.forge" })).toBe(false);
    expect(isStubArchivedSlice({ branch: "smithy/x" })).toBe(false);
  });

  it("alreadyArchivedSlice matches by action key, ignoring stubs at the same id", () => {
    // stub at the exact id does NOT block
    const stubState = { archived_slices: { [`stub`]: {} } };
    expect(alreadyArchivedSlice(stubState, item, "stub")).toBe(false);
    // a real archive with the same action key blocks
    const realState = {
      archived_slices: {
        other: { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(alreadyArchivedSlice(realState, item, "whatever")).toBe(true);
  });

  it("inFlightSliceMatches: same id, recovery original, or action key — but MERGED releases", () => {
    expect(inFlightSliceMatches({ slices: { sid: { stage: "implementing" } } }, item, "sid")).toBe(true);
    expect(
      inFlightSliceMatches({ slices: { r1: { original_slice_id: "sid", stage: "implementing" } } }, item, "sid"),
    ).toBe(true);
    // a MERGED live slice releases the artifact → does not count as in-flight
    const merged = {
      slices: { m: { stage: "merged", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
    };
    expect(inFlightSliceMatches(merged, item, "sid")).toBe(false);
  });

  it("blockingMergedArchive returns a MERGED collision, null otherwise", () => {
    const mergedArchive = {
      archived_slices: {
        a: { terminal_state: "MERGED", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(blockingMergedArchive(mergedArchive, item, "x")).toBeTruthy();
    const escalatedArchive = {
      archived_slices: {
        a: { terminal_state: "ESCALATED", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" },
      },
    };
    expect(blockingMergedArchive(escalatedArchive, item, "x")).toBeNull();
  });

  it("dispatchableReady drops ready items already in-flight or archived (#219)", () => {
    // No live/archived slices → the item is fresh-dispatchable.
    expect(dispatchableReady({ slices: {}, archived_slices: {} }, [item])).toEqual([item]);
    // An in-flight (implementing) slice matching the item's action key → not dispatchable.
    const inFlight = {
      slices: { s: { stage: "implementing", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
      archived_slices: {},
    };
    expect(dispatchableReady(inFlight, [item])).toEqual([]);
    // An escalated slice still holds the artifact (not MERGED) → not dispatchable.
    const escalated = {
      slices: { s: { stage: "escalated", command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" } },
      archived_slices: {},
    };
    expect(dispatchableReady(escalated, [item])).toEqual([]);
    expect(dispatchableReady({}, undefined)).toEqual([]);
  });

  it("summarizeSlicesByStage tallies by stage and tallies the merge_gate 3-way (#220)", () => {
    // The summary reads the merge_gate stamp babysit writes from the live PR — it
    // does NOT recompute, so each pr-open slice carries its verdict directly.
    const slices = {
      a: { stage: "hatchery-pending" },
      b: { stage: "implementing" },
      c: { stage: "pr-open", merge_gate: "ready" }, // loop will merge now
      d: { stage: "pr-open", merge_gate: "waiting-approval" }, // human gate
      e: { stage: "pr-open", merge_gate: "blocked-merge-state" }, // GitHub won't merge yet
      f: { stage: "pr-open", merge_gate: "not-ready" }, // checks pending / threads owed
      g: { stage: "escalated" },
    };
    const { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState } = summarizeSlicesByStage(slices);
    expect(byStage).toEqual({
      "hatchery-pending": 1,
      implementing: 1,
      "pr-open": 4,
      "pr-in-fix": 0,
      "pr-resolving-conflicts": 0,
      escalated: 1,
    });
    expect(Object.values(byStage).reduce((a, b) => a + b, 0)).toBe(Object.keys(slices).length);
    expect(readyToMerge).toBe(1); // c
    expect(waitingOnApproval).toBe(1); // d
    expect(blockedOnMergeState).toBe(1); // e
  });

  it("summarizeSlicesByStage buckets unknown stages; an unstamped pr-open counts in no merge bucket", () => {
    const slices = {
      typo: { stage: "implmenting" }, // typo / unexpected stage → 'other', not a new series
      merged: { stage: "merged" }, // transient terminal stage → 'other'
      // pr-open with no merge_gate yet (cold start, not re-snapshotted) → counted
      // in pr-open but in none of the merge buckets until babysit stamps it.
      cold: { stage: "pr-open" },
      ready: { stage: "pr-open", merge_gate: "ready" },
    };
    const { byStage, readyToMerge, waitingOnApproval, blockedOnMergeState } = summarizeSlicesByStage(slices);
    expect(byStage.other).toBe(2); // typo + merged bucketed together
    expect(byStage).not.toHaveProperty("implmenting");
    expect(byStage).not.toHaveProperty("merged");
    expect(byStage["pr-open"]).toBe(2);
    expect(readyToMerge).toBe(1);
    expect(waitingOnApproval).toBe(0);
    expect(blockedOnMergeState).toBe(0); // `cold` is unstamped → no bucket
  });

  it("summarizeSlicesByStage tallies the merge-blocker stamp (conflicting / owes_comments / …)", () => {
    const slices = {
      a: { stage: "pr-resolving-conflicts", pr_blocker: "conflicting" },
      b: { stage: "pr-open", pr_blocker: "owes_review_threads" },
      c: { stage: "pr-in-fix", pr_blocker: "owes_comments" },
      d: { stage: "pr-open", pr_blocker: "ci_failing" },
      e: { stage: "pr-open", pr_blocker: "none" }, // all-clear → not a tracked blocker
      f: { stage: "pr-open" }, // unstamped → counts in no blocker series
    };
    const { prBlocker } = summarizeSlicesByStage(slices);
    expect(prBlocker).toEqual({ conflicting: 1, owes_review_threads: 1, owes_comments: 1, ci_failing: 1 });
  });

  it("mergeBlocker classifies the dominant blocker in babysit's dispatch precedence", () => {
    const pr = (over: any) => ({ number: 5, checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0, ...over });
    // Precedence matches babysit's block order: conflict > review threads > CI >
    // conversation comments.
    expect(mergeBlocker({}, pr({ mergeable: "CONFLICTING", checks: "FAIL", needs_response_count: 2 }))).toBe("conflicting");
    expect(mergeBlocker({}, pr({ needs_response_count: 1, checks: "FAIL" }))).toBe("owes_review_threads");
    // CI wins over an unacked comment (babysit fixes CI before comment-fix).
    expect(mergeBlocker({}, pr({ conversation_comments: [{ id: 1, reacted_eyes: false }], checks: "FAIL" }))).toBe("ci_failing");
    expect(mergeBlocker({}, pr({ checks: "FAIL" }))).toBe("ci_failing");
    // owes_comments only once checks PASS (no CI to fix first).
    expect(mergeBlocker({}, pr({ conversation_comments: [{ id: 1, reacted_eyes: false }] }))).toBe("owes_comments");
    // All-clear, an acknowledged comment, or no PR → none.
    expect(mergeBlocker({}, pr({ conversation_comments: [{ id: 1, reacted_eyes: true }] }))).toBe("none");
    // March's own [march-bot] reply is not an outstanding comment (#374) → none.
    expect(
      mergeBlocker({}, pr({ conversation_comments: [{ id: 1, body_preview: "[march-bot] Fixed in abc", reacted_eyes: false }] })),
    ).toBe("none");
    expect(mergeBlocker({}, pr({}))).toBe("none");
    expect(mergeBlocker({}, {})).toBe("none"); // no observed PR
  });

  it("mergeReadiness is a 3-way over the LIVE pr, honoring the per-task-type merge policy", () => {
    const slice = { stage: "pr-open", branch: "feature/smithy/cut/x" };
    const clearPr = { checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0, merge_state_status: "clean" };
    // #298: cut drops the approval gate by default for EVERY profile, so even an
    // unapproved cut PR with no per-profile policy + clean merge state is ready.
    expect(mergeReadiness("x-cut", slice, clearPr, undefined)).toBe("ready");
    // A non-cut verb still requires approval under the all-required default.
    const forgeSlice = { stage: "pr-open", branch: "feature/smithy/forge/x" };
    expect(mergeReadiness("x-forge", forgeSlice, clearPr, undefined)).toBe("waiting-approval");
    // A bot approval only clears the gate when the policy accepts bot approvals.
    const botApproved = { ...clearPr, bot_approval_count: 1 };
    expect(mergeReadiness("x-forge", forgeSlice, botApproved, undefined)).toBe("waiting-approval");
    const codeRabbitApproved = {
      ...clearPr, head_sha: "head",
      reviews: [{ login: "coderabbitai", author_kind: "bot", state: "APPROVED", commit_sha: "head", submitted_at: "2026-11-16T12:00:00Z" }],
    };
    expect(mergeReadiness("x-forge", forgeSlice, codeRabbitApproved, undefined)).toBe("ready");
    expect(mergeReadiness("x-forge", forgeSlice, { ...codeRabbitApproved, head_sha: "new" }, undefined)).toBe("waiting-approval");
    // A profile can re-tighten cut explicitly → back to waiting-approval.
    const tighten = { byTaskType: { cut: { approval: true } } } as any;
    expect(mergeReadiness("x-cut", slice, clearPr, tighten)).toBe("waiting-approval");
    // An explicit per-profile relax is still honored (same as the built-in) → ready.
    const policy = { byTaskType: { cut: { approval: false } } } as any;
    expect(mergeReadiness("x-cut", slice, clearPr, policy)).toBe("ready");
    expect(mergeReadiness("x-cut", slice, { ...clearPr, checks: "NONE" }, policy)).toBe("ready");
    // Approval relaxed but GitHub merge-state present and not clean → blocked-merge-state.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, merge_state_status: "BEHIND" }, policy)).toBe("blocked-merge-state");
    // A MISSING/null/empty merge-state (sense-io null, or a cold-start thin pr) is
    // UNKNOWN, not a stall → not-ready (no false blocked-merge-state alarm).
    expect(mergeReadiness("x-cut", slice, { ...clearPr, merge_state_status: null }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", slice, { ...clearPr, merge_state_status: "" }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", slice, { checks: "PASS", mergeable: "MERGEABLE", needs_response_count: 0 }, policy)).toBe("not-ready");
    // A changes-requested review blocks on the human gate even when approval is relaxed.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, changes_requested_count: 1 }, policy)).toBe("waiting-approval");
    // Not all-clear (failing checks / threads owed / wrong stage) → not-ready.
    expect(mergeReadiness("x-cut", slice, { ...clearPr, checks: "FAIL" }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", slice, { ...clearPr, needs_response_count: 2 }, policy)).toBe("not-ready");
    expect(mergeReadiness("x-cut", { stage: "implementing" }, clearPr, policy)).toBe("not-ready");
  });

  it("summarizeSlicesByStage splits escalated by reason (spawn-failed vs stuck)", () => {
    const slices = {
      a: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed" }, // spawn failed
      b: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed" },
      c: { stage: "escalated", escalated_reason: "needs_human_judgement" }, // steward stuck
      d: { stage: "escalated", escalated_reason: "some_future_reason" }, // unknown → other
      e: { stage: "escalated" }, // no reason → other
      f: { stage: "implementing" }, // not escalated → not counted
    };
    const { byStage, escalatedByReason } = summarizeSlicesByStage(slices);
    expect(escalatedByReason.hatchery_dispatch_failed).toBe(2);
    expect(escalatedByReason.needs_human_judgement).toBe(1);
    expect(escalatedByReason.other).toBe(2); // unknown reason + missing reason
    // Pre-seeded reasons report 0 (stable series), not absent.
    expect(escalatedByReason.real_spawn_error).toBe(0);
    // The reason split sums to the escalated stage tally.
    const reasonSum = Object.values(escalatedByReason).reduce((a, b) => a + b, 0);
    expect(reasonSum).toBe(byStage.escalated);
    expect(reasonSum).toBe(5);
  });

  it("summarizeSlicesByStage pre-seeds all stages to 0 for an empty slice set", () => {
    expect(summarizeSlicesByStage(undefined)).toEqual({
      byStage: {
        "hatchery-pending": 0,
        implementing: 0,
        "pr-open": 0,
        "pr-in-fix": 0,
        "pr-resolving-conflicts": 0,
        escalated: 0,
      },
      readyToMerge: 0,
      waitingOnApproval: 0,
      blockedOnMergeState: 0,
      escalatedByReason: {
        hatchery_dispatch_failed: 0,
        needs_human: 0,
        needs_human_judgement: 0,
        real_spawn_error: 0,
        steward_stuck: 0,
        steward_awaiting_input: 0,
        other: 0,
      },
      prBlocker: {
        conflicting: 0,
        owes_review_threads: 0,
        owes_comments: 0,
        ci_failing: 0,
      },
    });
  });

  void ITEM_BRANCH;
});

describe("countStrandedSlices (steward-stage slices with no live steward)", () => {
  it("counts steward-stage slices whose worker session is empty or not live", () => {
    const slices = {
      adopted: { stage: "pr-open", worker_session_id: "" }, // adopt-from-fold, never got a steward
      crashed: { stage: "pr-open", worker_session_id: "dead-1" }, // steward vanished from Castra
      healthy: { stage: "pr-open", worker_session_id: "live-1" }, // live steward → not stranded
      fixing: { stage: "pr-in-fix", worker_session_id: "gone-2" }, // stranded
      rebasing: { stage: "pr-rebasing", worker_session_id: undefined }, // stranded (non-allowlist steward stage)
    };
    const live = new Set(["live-1"]);
    expect(countStrandedSlices(slices, live)).toBe(4);
  });

  it("ignores non-steward stages and an empty/absent slice set", () => {
    const slices = {
      queued: { stage: "hatchery-pending", worker_session_id: "" }, // no steward expected yet
      escalated: { stage: "escalated" }, // already surfaced on its own metric
      other: { stage: "archived", worker_session_id: "" }, // terminal/unknown stage
      working: { stage: "implementing", worker_session_id: "live-1" }, // live → not stranded
    };
    expect(countStrandedSlices(slices, new Set(["live-1"]))).toBe(0);
    expect(countStrandedSlices(undefined, new Set())).toBe(0);
    expect(countStrandedSlices({}, new Set())).toBe(0);
  });
});

describe("recoverableEscalations (#211/#460 self-healing auto-recovery)", () => {
  const SID = dispatchSliceId(item);
  const recoverableSlice = () => ({
    stage: "escalated",
    escalated_reason: "hatchery_dispatch_failed",
    command: "smithy.forge",
    arguments: ["docs/x.tasks.md", "1"],
    artifact_path: "docs/x.tasks.md",
  });

  it("escalatedRecoverable is true only for the recoverable allowlist", () => {
    expect(escalatedRecoverable(recoverableSlice())).toBe(true);
    expect(escalatedRecoverable({ stage: "escalated", escalated_reason: "needs_human" })).toBe(false);
    expect(escalatedRecoverable({ stage: "implementing", escalated_reason: "hatchery_dispatch_failed" })).toBe(false);
    expect(escalatedRecoverable(null)).toBe(false);
  });

  it("selects a ready item wedged behind a recoverable escalation, attempt = used+1", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: {} };
    expect(recoverableEscalations(state, [item])).toEqual([
      { item, sliceId: SID, attempt: 1, limit: DISPATCH_RECOVERY_LIMIT },
    ]);
  });

  it("counts the existing budget: a prior attempt yields attempt 2", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: { [recoveryAttemptKey(SID)]: 1 } };
    expect(recoverableEscalations(state, [item])[0]).toMatchObject({ attempt: 2 });
  });

  it("#460: does NOT stop at the old limit — keeps re-dispatching past it", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: { [recoveryAttemptKey(SID)]: DISPATCH_RECOVERY_LIMIT + 5 } };
    expect(recoverableEscalations(state, [item])).toEqual([
      { item, sliceId: SID, attempt: DISPATCH_RECOVERY_LIMIT + 6, limit: DISPATCH_RECOVERY_LIMIT },
    ]);
  });

  it("#460: skips a slice still inside its backoff window, admits it once elapsed", () => {
    const base = {
      slices: { [SID]: recoverableSlice() },
      archived_slices: {},
      transient_retry_counts: { [recoveryAttemptKey(SID)]: 3 },
      dispatch_recovery_backoff_until: { [SID]: 5000 },
    };
    // nowMs before the window → cooling down, not selected.
    expect(recoverableEscalations(base, [item], 4999)).toEqual([]);
    // nowMs at/after the window → eligible again.
    expect(recoverableEscalations(base, [item], 5000)).toHaveLength(1);
    // NaN clock (non-date tick) disables the gate entirely.
    expect(recoverableEscalations(base, [item], NaN)).toHaveLength(1);
  });

  it("#460: AIMD rate caps candidates per tick, longest-waiting (smallest until) first", () => {
    const itemA = { command: "smithy.forge", arguments: ["docs/a.tasks.md", "1"], path: "docs/a.tasks.md" };
    const itemB = { command: "smithy.forge", arguments: ["docs/b.tasks.md", "1"], path: "docs/b.tasks.md" };
    const itemC = { command: "smithy.forge", arguments: ["docs/c.tasks.md", "1"], path: "docs/c.tasks.md" };
    const idA = dispatchSliceId(itemA), idB = dispatchSliceId(itemB), idC = dispatchSliceId(itemC);
    const state = {
      slices: { [idA]: recoverableSlice(), [idB]: recoverableSlice(), [idC]: recoverableSlice() },
      archived_slices: {},
      transient_retry_counts: {},
      // A eligible longest ago, then C, then B.
      dispatch_recovery_backoff_until: { [idA]: 100, [idB]: 300, [idC]: 200 },
      dispatch_recovery_rate: 2, // R = 2 → only the two longest-waiting this tick
    };
    const out = recoverableEscalations(state, [itemA, itemB, itemC], 1000);
    expect(out.map((d) => d.sliceId)).toEqual([idA, idC]);
  });

  it("ignores a non-recoverable escalation reason", () => {
    const state = { slices: { [SID]: { ...recoverableSlice(), escalated_reason: "real_spawn_error" } }, archived_slices: {}, transient_retry_counts: {} };
    expect(recoverableEscalations(state, [item])).toEqual([]);
  });

  it("does not fight a terminal archive that also blocks the item", () => {
    const state = {
      slices: { [SID]: recoverableSlice() },
      archived_slices: { [SID]: { terminal_state: "MERGED", command: "smithy.forge", branch: "x" } },
      transient_retry_counts: {},
    };
    expect(recoverableEscalations(state, [item])).toEqual([]);
  });

  it("disjoint from dispatchableReady: the escalated item is never both", () => {
    const state = { slices: { [SID]: recoverableSlice() }, archived_slices: {}, transient_retry_counts: {} };
    expect(dispatchableReady(state, [item])).toEqual([]);
    expect(recoverableEscalations(state, [item])).toHaveLength(1);
  });

  it("recoveryBudgetExhausted flips only at/over the limit", () => {
    expect(recoveryBudgetExhausted({ transient_retry_counts: {} }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: 0 } }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: DISPATCH_RECOVERY_LIMIT - 1 } }, "x")).toBe(false);
    expect(recoveryBudgetExhausted({ transient_retry_counts: { [recoveryAttemptKey("x")]: DISPATCH_RECOVERY_LIMIT } }, "x")).toBe(true);
  });
});

describe("dispatch-recovery self-heal state (#460)", () => {
  it("scheduleDispatchRecoveryBackoff records now + an attempt-growing delay", () => {
    const state: any = {};
    scheduleDispatchRecoveryBackoff(state, "s", 1, 1000);
    const after1 = state[DISPATCH_RECOVERY_BACKOFF_FIELD].s;
    expect(after1).toBeGreaterThan(1000);
    scheduleDispatchRecoveryBackoff(state, "s", 4, 1000);
    // Later attempt → strictly longer window (exponential).
    expect(state[DISPATCH_RECOVERY_BACKOFF_FIELD].s).toBeGreaterThan(after1);
  });

  it("scheduleDispatchRecoveryBackoff is a no-op for a non-finite clock", () => {
    const state: any = {};
    scheduleDispatchRecoveryBackoff(state, "s", 1, NaN);
    expect(state[DISPATCH_RECOVERY_BACKOFF_FIELD]).toBeUndefined();
  });

  it("clearDispatchRecoveryBackoff removes a slice's window and tolerates absence", () => {
    const state: any = { [DISPATCH_RECOVERY_BACKOFF_FIELD]: { s: 1, t: 2 } };
    clearDispatchRecoveryBackoff(state, "s");
    expect(state[DISPATCH_RECOVERY_BACKOFF_FIELD]).toEqual({ t: 2 });
    expect(() => clearDispatchRecoveryBackoff({}, "missing")).not.toThrow();
  });

  it("AIMD decrease halves R (floored at 1); increase adds 1 (capped at 8)", () => {
    const state: any = { [DISPATCH_RECOVERY_RATE_FIELD]: 8 };
    decreaseDispatchRecoveryRate(state);
    expect(state[DISPATCH_RECOVERY_RATE_FIELD]).toBe(4);
    increaseDispatchRecoveryRate(state);
    expect(state[DISPATCH_RECOVERY_RATE_FIELD]).toBe(5);
    // Floor: an unset rate reads as 1, halving stays 1.
    const cold: any = {};
    decreaseDispatchRecoveryRate(cold);
    expect(cold[DISPATCH_RECOVERY_RATE_FIELD] ?? 1).toBe(1);
  });
});

// #599: before the fix, every row of a long-named tasks file got the same
// 56-character slice id, so once one row was archived MERGED (or in flight) its
// siblings were skipped on id alone. State keyed by that old cut id must still
// block the row that ran (via the action key) and must not block the siblings.
describe("legacy cut slice ids do not block sibling rows (#599)", () => {
  const SLUG = "structured-review-feedback-with-automatic-retry-handling";
  const SPEC = `docs/specs/${SLUG}/${SLUG}.spec.md`;
  const OLD_CUT_ID = `${SLUG}-forge`;
  // Each story has its own tasks file; the semantic id is derived from the spec.
  const row = (rowId: string, slice: string) => {
    const tasks = `docs/specs/${SLUG}/${rowId.toLowerCase()}.tasks.md`;
    return {
      path: tasks,
      parent_path: SPEC,
      parent_row_id: rowId,
      next_action: { command: "smithy.forge", arguments: [tasks, slice] },
    };
  };
  const us1s1 = row("US1", "1");
  const us1s2 = row("US1", "2");
  const us2s1 = row("US2", "1");
  const us3s4 = row("US3", "4");
  const ranSlice = {
    command: "smithy.forge",
    arguments: [us1s1.path, "1"],
    artifact_path: us1s1.path,
    branch: `smithy/forge/${SLUG}`,
  };

  it("rows now get distinct ids, none equal to the old cut id", () => {
    const ids = [us1s1, us1s2, us2s1, us3s4].map(dispatchSliceId);
    expect(new Set(ids).size).toBe(4);
    expect(ids).not.toContain(OLD_CUT_ID);
  });

  it("an archived MERGED slice under the old id blocks only the row that ran", () => {
    const state = {
      slices: {},
      archived_slices: { [OLD_CUT_ID]: { ...ranSlice, terminal_state: "MERGED" } },
    };
    expect(dispatchableReady(state, [us1s1, us1s2, us2s1, us3s4])).toEqual([us1s2, us2s1, us3s4]);
  });

  it("a live slice under the old id keeps only the row that ran in flight", () => {
    const state = { slices: { [OLD_CUT_ID]: { ...ranSlice, stage: "implementing" } }, archived_slices: {} };
    expect(dispatchableReady(state, [us1s1, us1s2, us2s1, us3s4])).toEqual([us1s2, us2s1, us3s4]);
  });

  // After a restart the working state is rebuilt from the Herald fold. A slice
  // dispatched before #653 has no action key there (only id + branch), so an
  // old-id entry cannot say which row it was for. (With the key, see sense.test.ts.)
  describe("entries rebuilt without an action key (cold start)", () => {
    const rebuiltArchive = (terminal_state: string | null) => ({
      pr_number: 1, pr_url: null, branch: `smithy/forge/${SLUG}`, terminal_state,
    });
    const all = [us1s1, us1s2, us2s1, us3s4];

    it("a MERGED archive under the old id blocks nothing (smithy marks the merged row done)", () => {
      const state = { slices: {}, archived_slices: { [OLD_CUT_ID]: rebuiltArchive("MERGED") } };
      expect(dispatchableReady(state, all)).toEqual(all);
    });

    it("an escalated/closed archive under the old id keeps blocking every row that maps to it", () => {
      for (const terminal of ["CLOSED", null]) {
        const state = { slices: {}, archived_slices: { [OLD_CUT_ID]: rebuiltArchive(terminal) } };
        expect(dispatchableReady(state, all)).toEqual([]);
      }
    });

    it("a live slice under the old id blocks every row that maps to it (no duplicate dispatch)", () => {
      const live = { kind: "smithy", branch: `smithy/forge/${SLUG}`, stage: "implementing", pr: null };
      expect(dispatchableReady({ slices: { [OLD_CUT_ID]: live }, archived_slices: {} }, all)).toEqual([]);
      // Matched by the old branch too, whatever the key.
      expect(dispatchableReady({ slices: { other: live }, archived_slices: {} }, all)).toEqual([]);
    });

    it("a live MERGED slice under the old id releases its rows", () => {
      const merged = { kind: "smithy", branch: `smithy/forge/${SLUG}`, stage: "merged", pr: { state: "MERGED" } };
      expect(dispatchableReady({ slices: { [OLD_CUT_ID]: merged }, archived_slices: {} }, all)).toEqual(all);
    });

    it("rows whose id never changed are unaffected", () => {
      const short = {
        path: "docs/short/us1.tasks.md", parent_path: "docs/short/short.spec.md", parent_row_id: "US1",
        next_action: { command: "smithy.forge", arguments: ["docs/short/us1.tasks.md", "1"] },
      };
      const live = { kind: "smithy", branch: `smithy/forge/${SLUG}`, stage: "implementing", pr: null };
      expect(dispatchableReady({ slices: { [OLD_CUT_ID]: live }, archived_slices: {} }, [short])).toEqual([short]);
    });
  });

  describe("recovering an escalation stored under the old id", () => {
    const escalated = (extra: object = {}) => ({
      kind: "smithy", branch: `smithy/forge/${SLUG}`, stage: "escalated",
      escalated_reason: "hatchery_dispatch_failed", ...extra,
    });

    it("is recovered under the old id when it carries the item's action key", () => {
      const state = {
        slices: { [OLD_CUT_ID]: escalated({ command: "smithy.forge", arguments: [us2s1.path, "1"], artifact_path: us2s1.path }) },
        archived_slices: {}, transient_retry_counts: {},
      };
      const out = recoverableEscalations(state, [us1s1, us2s1, us3s4]);
      expect(out.map((r) => [r.item, r.sliceId])).toEqual([[us2s1, OLD_CUT_ID]]);
    });

    it("rebuilt without an action key: recovered only when one ready item maps to the old id", () => {
      const state = { slices: { [OLD_CUT_ID]: escalated() }, archived_slices: {}, transient_retry_counts: {} };
      expect(recoverableEscalations(state, [us1s2]).map((r) => r.sliceId)).toEqual([OLD_CUT_ID]);
      expect(recoverableEscalations(state, [us1s1, us2s1])).toEqual([]);
    });

    it("is never also dispatched fresh", () => {
      const state = { slices: { [OLD_CUT_ID]: escalated() }, archived_slices: {}, transient_retry_counts: {} };
      expect(dispatchableReady(state, [us1s2])).toEqual([]);
    });
  });
});

describe("classifyReady (#592 per-item dispatch decisions)", () => {
  const SID = dispatchSliceId(item);
  const action = { command: "smithy.forge", arguments: ["docs/x.tasks.md", "1"], artifact_path: "docs/x.tasks.md" };
  const one = (state: any, nowMs = NaN) => classifyReady(state, [item], nowMs)[0];

  it("a ready item with no blocker dispatches", () => {
    expect(one({ slices: {}, archived_slices: {} })).toMatchObject({
      decision: "dispatch",
      sliceId: SID,
      path: "docs/x.tasks.md",
      command: "smithy.forge",
      arguments: ["docs/x.tasks.md", "1"],
    });
  });

  it("an archived CLOSED slice with the same id holds the item as archived_closed", () => {
    const state = { slices: {}, archived_slices: { [SID]: { ...action, terminal_state: "CLOSED", pr_number: 333 } } };
    expect(one(state)).toMatchObject({
      decision: "archived_closed",
      heldBy: { sliceId: SID, matchedOn: "id", terminal: "CLOSED", prNumber: 333 },
    });
  });

  it("an archived MERGED slice under ANOTHER id but the same action key is archived_merged, held by that id", () => {
    const state = { slices: {}, archived_slices: { "other-forge": { ...action, terminal_state: "MERGED", pr_number: 513 } } };
    expect(one(state)).toMatchObject({
      decision: "archived_merged",
      heldBy: { sliceId: "other-forge", matchedOn: "action_key", terminal: "MERGED", prNumber: 513 },
    });
  });

  it("an archive matched only by branch, with no terminal PR, is archived_other", () => {
    const branch = classifyReady({}, [item])[0].branch;
    const state = { slices: {}, archived_slices: { old: { command: "smithy.cut", branch, terminal_state: null } } };
    expect(one(state)).toMatchObject({ decision: "archived_other", heldBy: { sliceId: "old", matchedOn: "branch", terminal: null } });
  });

  it("a stub archive at the item's id does not hold it", () => {
    expect(one({ slices: {}, archived_slices: { [SID]: {} } }).decision).toBe("dispatch");
  });

  it("a live slice is in_flight; a merged live slice with another id releases the artifact", () => {
    expect(one({ slices: { [SID]: { stage: "pr-open" } }, archived_slices: {} })).toMatchObject({
      decision: "in_flight",
      heldBy: { sliceId: SID, matchedOn: "id", stage: "pr-open" },
    });
    expect(one({ slices: { other: { ...action, stage: "merged" } }, archived_slices: {} }).decision).toBe("dispatch");
    expect(one({ slices: { other: { ...action, stage: "implementing" } }, archived_slices: {} })).toMatchObject({
      decision: "in_flight",
      heldBy: { sliceId: "other", matchedOn: "action_key" },
    });
  });

  it("a recoverable escalation is recovery_due, or recovery_backoff with retryAt while cooling down", () => {
    const escalated = { ...action, stage: "escalated", escalated_reason: "hatchery_dispatch_failed" };
    expect(one({ slices: { [SID]: escalated }, archived_slices: {} }).decision).toBe("recovery_due");
    const until = Date.parse("2026-11-19T12:00:00.000Z");
    const cooling = { slices: { [SID]: escalated }, archived_slices: {},
      transient_retry_counts: { [recoveryAttemptKey(SID)]: 1 },
      [DISPATCH_RECOVERY_BACKOFF_FIELD]: { [SID]: until },
    };
    expect(one(cooling, until - 1000)).toMatchObject({ decision: "recovery_backoff", retryAt: "2026-11-19T12:00:00.000Z" });
  });

  it("a non-recoverable escalation stays in_flight", () => {
    const state = { slices: { [SID]: { ...action, stage: "escalated", escalated_reason: "steward_awaiting_input" } }, archived_slices: {} };
    expect(one(state)).toMatchObject({ decision: "in_flight", heldBy: { escalatedReason: "steward_awaiting_input" } });
  });

  it("agrees with dispatchableReady on which items dispatch", () => {
    const other = { path: "docs/y.tasks.md", next_action: { command: "smithy.forge", arguments: ["docs/y.tasks.md", "1"] } };
    const state = { slices: {}, archived_slices: { [SID]: { ...action, terminal_state: "CLOSED" } } };
    const dispatching = classifyReady(state, [item, other]).filter((r) => r.decision === "dispatch").map((r) => r.sliceId);
    expect(dispatching).toEqual(dispatchableReady(state, [item, other]).map((i) => dispatchSliceId(i)));
  });

  it("the finders back the boolean matchers", () => {
    const state = { slices: { [SID]: { stage: "implementing" } }, archived_slices: {} };
    expect(findLiveBlocker(state, item, SID)).not.toBeNull();
    expect(inFlightSliceMatches(state, item, SID)).toBe(true);
    expect(findArchiveBlocker(state, item, SID)).toBeNull();
    expect(alreadyArchivedSlice(state, item, SID)).toBe(false);
  });
});

describe("classifyReady with pre-#599 cut ids (#599)", () => {
  const SLUG = "structured-review-feedback-with-automatic-retry-handling";
  const OLD_CUT_ID = `${SLUG}-forge`;
  const row = (rowId: string, slice: string) => {
    const tasks = `docs/specs/${SLUG}/${rowId.toLowerCase()}.tasks.md`;
    return {
      path: tasks, parent_path: `docs/specs/${SLUG}/${SLUG}.spec.md`, parent_row_id: rowId,
      next_action: { command: "smithy.forge", arguments: [tasks, slice] },
    };
  };
  const us1 = row("US1", "1");
  const us2 = row("US2", "1");
  const branch = `smithy/forge/${SLUG}`;

  it("labels a rebuilt live old-id slice as in_flight via legacy_id", () => {
    const state = { slices: { [OLD_CUT_ID]: { branch, stage: "implementing" } }, archived_slices: {} };
    const rows = classifyReady(state, [us1, us2]);
    expect(rows.map((r) => [r.decision, r.heldBy?.matchedOn, r.heldBy?.sliceId])).toEqual([
      ["in_flight", "legacy_id", OLD_CUT_ID],
      ["in_flight", "legacy_id", OLD_CUT_ID],
    ]);
  });

  it("labels a rebuilt non-MERGED old-id archive as archived via legacy_id; MERGED dispatches", () => {
    const closed = { archived_slices: { [OLD_CUT_ID]: { branch, terminal_state: "CLOSED" } }, slices: {} };
    expect(classifyReady(closed, [us2])[0]).toMatchObject({ decision: "archived_closed", heldBy: { matchedOn: "legacy_id" } });
    const merged = { archived_slices: { [OLD_CUT_ID]: { branch, terminal_state: "MERGED" } }, slices: {} };
    expect(classifyReady(merged, [us2])[0]).toMatchObject({ decision: "dispatch" });
  });

  it("labels the owner of an old-id recoverable escalation recovery_due, its siblings in_flight", () => {
    const state = {
      slices: {
        [OLD_CUT_ID]: {
          branch, stage: "escalated", escalated_reason: "hatchery_dispatch_failed",
          command: "smithy.forge", arguments: [us2.path, "1"], artifact_path: us2.path,
        },
      },
      archived_slices: {}, transient_retry_counts: {},
    };
    const rows = classifyReady(state, [us1, us2]);
    // us1 has a different action key, so the keyed entry does not hold it at all.
    expect(rows.map((r) => r.decision)).toEqual(["dispatch", "recovery_due"]);
    expect(rows[1]!.heldBy).toMatchObject({ sliceId: OLD_CUT_ID, matchedOn: "action_key" });
  });
});
