import { describe, expect, it, vi } from "vitest";
import { rebuildWorkingState, senseFromHerald, senseObserved, type SenseDeps } from "./sense.js";
import type { LoopMeta } from "../meta.js";
import { emptySystemState, type SliceState, type SystemState } from "../../../herald/events.js";

const meta = { worker_group: "legate-workers", repo: { name: "march", path: "/repo" } } as unknown as LoopMeta;

function deps(over: Partial<SenseDeps> = {}): SenseDeps {
  return {
    meta,
    now: () => "2026-05-20T00:00:00Z",
    listSessions: async () => [],
    syncDefaultBranch: async () => {},
    readSmithyStatus: async () => ({ records: [], graph: {} }),
    queryPr: async () => ({}),
    sessionOutput: async () => ({ output: "" }),
    ...over,
  };
}

function foldedState(over: Partial<SystemState> = {}): SystemState {
  return { ...emptySystemState(), ...over };
}

function slice(over: Partial<SliceState> & { sliceId: string }): SliceState {
  return { ...over };
}

describe("senseFromHerald (Stage 1, Herald-backed)", () => {
  const prevRaw = () => ({ repo: { path: "/repo" }, slices: {}, archived_slices: {} });

  it("maps the folded projection (sessions/workers/perSlice) into the LoopState", async () => {
    const sys = foldedState({
      sessions: {
        s1: { id: "s1", present: true, status: "running", group: "legate-workers", worktreePath: "/wt/s1", title: "steward-1" },
      },
      workers: { waiting: 0, running: 1, idle: 0, error: 0, stopped: 0, other: 0 },
      slices: {
        active: { sliceId: "active", stage: "pr-open", pr: { number: 7, state: "OPEN" }, recentOutput: { output: "log" } },
        bare: { sliceId: "bare" },
      },
    });
    const herald = { consume: vi.fn(async () => sys) };
    const state = await senseFromHerald(deps(), herald, prevRaw());

    // sessions are re-shaped to the agent-deck snake_case form the handlers read.
    expect(state.sessions).toEqual([
      { id: "s1", title: "steward-1", name: "steward-1", status: "running", group: "legate-workers", worktree_path: "/wt/s1", branch: undefined, created_at: undefined },
    ]);
    expect(state.sessionsById.get("s1")).toBeTruthy();
    expect(state.sessionsById.get("steward-1")).toBeTruthy();
    expect(state.workers).toMatchObject({ running: 1 });
    // perSlice only carries slices that actually have observed pr/output.
    expect(Object.keys(state.perSlice)).toEqual(["active"]);
    expect(state.perSlice.active!.pr).toMatchObject({ number: 7 });
    expect(state.perSlice.active!.recentOutput).toEqual({ output: "log" });
  });

  it("threads the in-memory working state across ticks (no state.json)", async () => {
    const raw = { repo: { path: "/repo" }, slices: { s: { worker_session_id: "x", stage: "implementing" } }, archived_slices: { old: {} } };
    const herald = { consume: vi.fn(async () => emptySystemState()) };
    const state = await senseFromHerald(deps(), herald, raw);
    expect(state.statePresent).toBe(true);
    expect(state.raw).toBe(raw); // same object reused, not re-read from disk
    expect(state.slices).toBe(raw.slices);
    expect(state.slices).toHaveProperty("s");
    expect(state.archived).toHaveProperty("old");
    expect(herald.consume).toHaveBeenCalledOnce();
  });

  it("rebuilds the working state from the fold on cold start (prevRaw null)", async () => {
    const sys = foldedState({
      slices: {
        live: { sliceId: "live", stage: "implementing", branch: "smithy/forge/x", worktreePath: "/wt/x", sessionId: "sess-1", pr: { number: 9, state: "OPEN" } },
        done: { sliceId: "done", stage: "merged", branch: "smithy/forge/y", archived: true, pr: { number: 4, state: "MERGED", url: "u" } },
      },
      retries: { "spawn-error:live": 2 },
    });
    const herald = { consume: vi.fn(async () => sys) };
    const state = await senseFromHerald(deps(), herald, null);

    expect(state.raw.slices.live).toMatchObject({
      worker_session_id: "sess-1",
      branch: "smithy/forge/x",
      worktree_path: "/wt/x",
      stage: "implementing",
      pr: { number: 9, state: "OPEN" },
    });
    // archived slices land in archived_slices, not the live set.
    expect(state.raw.slices).not.toHaveProperty("done");
    expect(state.raw.archived_slices.done).toMatchObject({ pr_number: 4, pr_url: "u", branch: "smithy/forge/y", terminal_state: "MERGED" });
    expect(state.raw.transient_retry_counts).toEqual({ "spawn-error:live": 2 });
    expect(state.raw.repo).toMatchObject({ path: "/repo" });
  });

  it("reads smithy ready records WITHOUT syncing (Herald owns the sync)", async () => {
    const syncDefaultBranch = vi.fn(async () => {});
    const herald = { consume: vi.fn(async () => emptySystemState()) };
    const state = await senseFromHerald(
      deps({
        syncDefaultBranch,
        readSmithyStatus: async () => ({ records: [{ path: "a", next_action: { command: "smithy.forge" } }], graph: {} }),
      }),
      herald,
      prevRaw(),
    );
    expect(syncDefaultBranch).not.toHaveBeenCalled();
    expect(state.smithy.ok).toBe(true);
    expect(state.smithy.queue.dispatchable).toBe(1);
  });

  it("dispatchable excludes ready items already in-flight/escalated, keeps total (#219)", async () => {
    // One ready item ("a"); the working state already has it implementing and an
    // escalated slice ("b"). Raw ready=2 but neither dispatches → dispatchable 0,
    // while blocked/total stay the smithy planning view.
    const raw = {
      repo: { path: "/repo" },
      slices: {
        a: { stage: "implementing", command: "smithy.forge", artifact_path: "a" },
        b: { stage: "escalated", command: "smithy.forge", artifact_path: "b" },
      },
      archived_slices: {},
    };
    const herald = { consume: vi.fn(async () => emptySystemState()) };
    const state = await senseFromHerald(
      deps({
        readSmithyStatus: async () => ({
          records: [
            { path: "a", next_action: { command: "smithy.forge" } },
            { path: "b", next_action: { command: "smithy.forge" } },
          ],
          graph: {},
        }),
      }),
      herald,
      raw,
    );
    expect(state.smithy.ready).toHaveLength(2);
    expect(state.smithy.queue).toEqual({ dispatchable: 0, blocked: 0, total: 2 });
  });

  it("reports unavailable workers when the fold has none", async () => {
    const herald = { consume: vi.fn(async () => emptySystemState()) };
    const state = await senseFromHerald(deps(), herald, prevRaw());
    expect(state.workers).toEqual({ error: "unavailable" });
  });
});

describe("rebuildWorkingState", () => {
  it("restores the slice set + retry counters from the fold", () => {
    const sys = foldedState({
      slices: {
        a: { sliceId: "a", stage: "pr-open", branch: "b-a", worktreePath: "/wt/a", sessionId: "s-a", pr: { number: 1, state: "OPEN" } },
        gone: { sliceId: "gone", stage: "merged", archived: true, branch: "b-gone", pr: { number: 2, state: "MERGED", url: "uu" } },
        closed: { sliceId: "closed", archived: true, branch: "b-c", pr: { number: 3, state: "CLOSED" } },
      },
      retries: { k: 5 },
    });
    const raw = rebuildWorkingState(sys, meta);
    expect(Object.keys(raw.slices)).toEqual(["a"]);
    expect(raw.slices.a).toMatchObject({ kind: "smithy", worker_session_id: "s-a", branch: "b-a", worktree_path: "/wt/a", stage: "pr-open" });
    expect(raw.archived_slices.gone).toMatchObject({ terminal_state: "MERGED", pr_number: 2, pr_url: "uu", branch: "b-gone" });
    expect(raw.archived_slices.closed).toMatchObject({ terminal_state: "CLOSED", pr_number: 3 });
    expect(raw.transient_retry_counts).toEqual({ k: 5 });
    expect(raw.repo).toMatchObject({ name: "march", path: "/repo" });
  });

  it("carries an escalation reason onto the rebuilt slice note + structured class (#211)", () => {
    const sys = foldedState({ slices: { e: { sliceId: "e", stage: "escalated", escalatedReason: "hatchery_dispatch_failed" } } });
    const raw = rebuildWorkingState(sys, meta);
    // The structured field lets bounded auto-recovery (#211) tell a recoverable
    // escalation from a terminal one after a cold start, not just the human note.
    expect(raw.slices.e).toMatchObject({ stage: "escalated", last_action_note: "hatchery_dispatch_failed", escalated_reason: "hatchery_dispatch_failed" });
  });

  it("skips recovered (tombstoned) slices so they don't block re-dispatch (#238)", () => {
    const sys = foldedState({
      slices: {
        live: { sliceId: "live", stage: "pr-open", branch: "b-live", pr: { number: 1, state: "OPEN" } },
        tomb: { sliceId: "tomb", recovered: true },
      },
    });
    const raw = rebuildWorkingState(sys, meta);
    // The tombstone is reconstructed into neither the live nor the archived set.
    expect(Object.keys(raw.slices)).toEqual(["live"]);
    expect(raw.archived_slices.tomb).toBeUndefined();
  });
});

describe("senseObserved (Herald observation Stage 1)", () => {
  it("observes PR + output for live, non-terminal slices from the projection", async () => {
    const queryPr = vi.fn(async () => ({ number: 7, state: "OPEN" }));
    const sessionOutput = vi.fn(async () => ({ output: "log" }));
    const prev = foldedState({
      slices: {
        active: slice({ sliceId: "active", stage: "pr-open", sessionId: "s1", branch: "b-active" }),
        terminal: slice({ sliceId: "terminal", stage: "merged", sessionId: "s2" }), // skipped (terminal)
        noSession: slice({ sliceId: "noSession", stage: "implementing" }), // skipped (no session)
        archived: slice({ sliceId: "archived", sessionId: "s3", archived: true }), // skipped (archived)
        noLiveSession: slice({ sliceId: "noLiveSession", stage: "implementing", sessionId: "s9" }), // skipped (session absent)
      },
    });
    const state = await senseObserved(
      deps({
        listSessions: async () => [
          { id: "s1", group: "legate-workers", status: "idle" },
          { id: "s2", group: "legate-workers", status: "idle" },
          { id: "s3", group: "legate-workers", status: "idle" },
        ],
        queryPr,
        sessionOutput,
      }),
      prev,
    );
    expect(Object.keys(state.perSlice)).toEqual(["active"]);
    expect(state.perSlice.active!.pr).toMatchObject({ number: 7 });
    expect(state.perSlice.active!.recentOutput).toEqual({ output: "log" });
    expect(queryPr).toHaveBeenCalledTimes(1);
    expect(sessionOutput).toHaveBeenCalledWith("s1");
    expect(state.statePresent).toBe(true);
  });

  it("discovers a PR for an implementing slice when queryPr skips", async () => {
    const discoverPr = vi.fn(async () => ({ number: 42, state: "OPEN" }));
    const prev = foldedState({
      slices: { impl: slice({ sliceId: "impl", stage: "implementing", sessionId: "s1", branch: "b-impl" }) },
    });
    const state = await senseObserved(
      deps({
        listSessions: async () => [{ id: "s1", group: "legate-workers", status: "idle" }],
        queryPr: async () => ({ skipped: true }),
        discoverPr,
        sessionOutput: async () => ({ output: "" }),
      }),
      prev,
    );
    expect(discoverPr).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/repo", "s1");
    expect(state.perSlice.impl!.pr).toMatchObject({ number: 42 });
  });

  it("matches a recorded sessionId only against session id, never title/name", async () => {
    const queryPr = vi.fn(async () => ({ number: 7, state: "OPEN" }));
    const sessionOutput = vi.fn(async () => ({ output: "log" }));
    const prev = foldedState({
      slices: { impl: slice({ sliceId: "impl", stage: "implementing", sessionId: "s1" }) },
    });
    const state = await senseObserved(
      deps({
        listSessions: async () => [
          // A decoy whose TITLE equals the recorded id but with a different real id.
          { id: "decoy", title: "s1", group: "legate-workers", status: "idle" },
          // The authoritative session.
          { id: "s1", group: "legate-workers", status: "idle" },
        ],
        queryPr,
        sessionOutput,
      }),
      prev,
    );
    // Discovery/output read against the real id, not the title-decoy.
    expect(sessionOutput).toHaveBeenCalledWith("s1");
    expect(state.perSlice.impl!.pr).toMatchObject({ number: 7 });
  });

  it("skips a slice whose recorded sessionId only matches a session title (no real id match)", async () => {
    const prev = foldedState({
      slices: { impl: slice({ sliceId: "impl", stage: "implementing", sessionId: "s1" }) },
    });
    const state = await senseObserved(
      deps({
        // Only a title-decoy is live; the real session id is gone.
        listSessions: async () => [{ id: "decoy", title: "s1", group: "legate-workers", status: "idle" }],
        queryPr: async () => ({ number: 7 }),
      }),
      prev,
    );
    expect(state.perSlice.impl).toBeUndefined();
  });

  it("reconciles a slice with no recorded sessionId by Castra session metadata (#214 pull)", async () => {
    const discoverPr = vi.fn(async () => ({ number: 99, state: "OPEN" }));
    const prev = foldedState({
      // The push (#213) was missed: the slice has no sessionId in the fold.
      slices: { impl: slice({ sliceId: "impl", stage: "implementing", branch: "b-impl" }) },
    });
    const state = await senseObserved(
      deps({
        listSessions: async () => [
          // The session self-describes its slice via Castra metadata.
          { id: "ad-9", group: "legate-workers", status: "idle", metadata: { sliceId: "impl" } },
        ],
        queryPr: async () => ({ skipped: true }),
        discoverPr,
        sessionOutput: async () => ({ output: "" }),
      }),
      prev,
    );
    // Discovery runs against the metadata-resolved session id, not skipped.
    expect(discoverPr).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/repo", "ad-9");
    expect(state.perSlice.impl!.pr).toMatchObject({ number: 99 });
  });

  it("degrades to a worktree/branch match when sessionId is absent (#210 gate)", async () => {
    const discoverPr = vi.fn(async () => ({ number: 203, state: "OPEN" }));
    const prev = foldedState({
      slices: {
        impl: slice({ sliceId: "impl", stage: "implementing", branch: "smithy/forge/x", worktreePath: "/wt/x" }),
      },
    });
    const state = await senseObserved(
      deps({
        listSessions: async () => [
          // No metadata and no matching id — only the worktree/branch line up,
          // exactly the stranded-steward case from #210.
          { id: "ad-7", group: "legate-workers", status: "idle", branch: "feature/smithy/forge/x", worktree_path: "/wt/x" },
        ],
        queryPr: async () => ({ skipped: true }),
        discoverPr,
        sessionOutput: async () => ({ output: "" }),
      }),
      prev,
    );
    expect(discoverPr).toHaveBeenCalledWith(expect.anything(), expect.anything(), "/repo", "ad-7");
    expect(state.perSlice.impl!.pr).toMatchObject({ number: 203 });
  });

  it("assembles workers + smithy queue from the live world", async () => {
    const state = await senseObserved(
      deps({
        listSessions: async () => [{ id: "s1", group: "legate-workers", status: "running" }],
        readSmithyStatus: async () => ({
          records: [
            { path: "a", next_action: { command: "smithy.forge" } },
            { path: "b", next_action: { command: "smithy.cut" } },
          ],
          graph: {},
        }),
      }),
      emptySystemState(),
    );
    expect(state.workers).toMatchObject({ running: 1 });
    expect(state.smithy.ok).toBe(true);
    expect(state.smithy.queue).toEqual({ dispatchable: 2, blocked: 0, total: 2 });
  });

  it("surfaces a smithy read failure as smithy.ok=false (non-fatal)", async () => {
    const state = await senseObserved(
      deps({
        readSmithyStatus: async () => {
          throw new Error("smithy down");
        },
      }),
      emptySystemState(),
    );
    expect(state.smithy.ok).toBe(false);
    expect(state.smithy.error).toBe("smithy down");
  });
});
