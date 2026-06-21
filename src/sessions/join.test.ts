/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { emptyMultiProfileState, type MultiProfileState, type SliceState } from "../herald/events.js";
import type { CastraSession } from "../castra/types.js";
import type { SessionRecord } from "../brood/service/types.js";
import type { SessionSources } from "./gather.js";
import { joinSessions } from "./join.js";

const NOW = Date.parse("2026-06-16T12:00:00.000Z");

function foldWith(profile: string, slices: Record<string, SliceState>): MultiProfileState {
  const fold = emptyMultiProfileState();
  fold.byProfile[profile] = {
    seq: 1,
    ts: "",
    statePresent: true,
    stateError: null,
    slices,
    sessions: {},
    workers: null,
    smithy: { dispatchable: 0, blocked: 0, total: 0 },
    retries: {},
  };
  return fold;
}

function castra(overrides: Partial<CastraSession> = {}): CastraSession {
  return {
    sessionId: "sess-1",
    title: "steward",
    group: "legate-workers",
    branch: "feature/smithy/cut/foo",
    worktreePath: "/wt/foo-abc",
    createdAt: "2026-06-16T11:00:00.000Z",
    status: "running",
    ...overrides,
  };
}

function broodRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    id: "spawn-1",
    kind: "spawn",
    status: "running",
    profile: "march",
    createdAt: "2026-06-16T10:00:00.000Z",
    updatedAt: "2026-06-16T10:00:00.000Z",
    ...overrides,
  };
}

function sources(partial: Partial<SessionSources>): SessionSources {
  return {
    brood: [],
    castraByProfile: new Map(),
    fold: emptyMultiProfileState(),
    profiles: [],
    errors: [],
    ...partial,
  };
}

describe("joinSessions", () => {
  it("joins a slice + its Castra session + Brood records into one corroborated row", () => {
    const slice: SliceState = {
      sliceId: "foo-cut",
      stage: "pr-open",
      branch: "feature/smithy/cut/foo",
      worktreePath: "/wt/foo-abc",
      sessionId: "sess-1",
      spawnId: "spawn-1",
      pr: { number: 412, state: "OPEN" },
    };
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "foo-cut": slice }),
        castraByProfile: new Map([["march", [castra({ sessionId: "sess-1" })]]]),
        brood: [
          broodRecord({ id: "spawn-1", kind: "spawn", containerId: "container123456789", worktreePath: "/wt/foo-abc" }),
          broodRecord({ id: "sess-1", kind: "steward", agentDeckSessionId: "sess-1", parentId: "spawn-1", worktreePath: "/wt/foo-abc" }),
        ],
      }),
      NOW,
    );

    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row.sliceId).toBe("foo-cut");
    expect(row.profile).toBe("march");
    expect(row.state).toBe("waiting-for-merge");
    expect(row.pr).toBe(412);
    expect(row.containerId).toBe("container123456789");
    expect(row.castraSessionId).toBe("sess-1");
    expect(row.broodStatus).toBe("running");
    expect(row.broodKind).toBe("steward"); // steward preferred over spawn
    expect(row.presence).toEqual({ herald: true, castra: true, brood: true });
    expect(row.divergence).toBe("ok");
  });

  it("flags a Castra session with no Brood record as a leak (castra-only)", () => {
    const rows = joinSessions(
      sources({
        castraByProfile: new Map([
          ["march", [castra({ sessionId: "ghost", metadata: { sliceId: "ghost-cut" }, status: "waiting" })]],
        ]),
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].divergence).toBe("castra-only");
    expect(rows[0].sliceId).toBe("ghost-cut");
    expect(rows[0].castraSessionId).toBe("ghost");
    expect(rows[0].presence).toEqual({ herald: false, castra: true, brood: false });
  });

  it("flags a tracked Brood record with no live Castra session as a dead orphan (brood-only)", () => {
    const rows = joinSessions(
      sources({
        brood: [
          broodRecord({ id: "stew-9", kind: "steward", agentDeckSessionId: "stew-9", branch: "feature/x", status: "running" }),
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].divergence).toBe("brood-only");
    expect(rows[0].broodKind).toBe("steward");
    expect(rows[0].presence).toEqual({ herald: false, castra: false, brood: true });
  });

  it("flags a fold slice with neither Castra nor Brood as a stale projection (fold-only)", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "stale-cut": { sliceId: "stale-cut", stage: "implementing", sessionId: "gone" } }),
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].divergence).toBe("fold-only");
    expect(rows[0].state).toBe("in-steward");
  });

  it("does NOT flag a session-less waiting-for-merge slice as stale (no live steward is expected)", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", {
          "merge-cut": { sliceId: "merge-cut", stage: "pr-open", pr: { number: 9, state: "OPEN" } },
        }),
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe("waiting-for-merge");
    expect(rows[0].divergence).toBe("ok"); // fold-only, but a session is not expected here
  });

  it("excludes archived slices, legate records, and torndown records", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "done-cut": { sliceId: "done-cut", stage: "merged", archived: true } }),
        brood: [
          broodRecord({ id: "legate-1", kind: "legate", status: "running" }),
          broodRecord({ id: "old-1", kind: "steward", status: "torndown" }),
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("matches a Castra session to its slice by metadata.sliceId even when worktree differs", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "m-cut": { sliceId: "m-cut", stage: "implementing" } }),
        castraByProfile: new Map([
          ["march", [castra({ sessionId: "s", metadata: { sliceId: "m-cut" }, worktreePath: "/other" })]],
        ]),
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].divergence).toBe("castra-only"); // herald+castra, no brood => leak
    expect(rows[0].presence).toEqual({ herald: true, castra: true, brood: false });
  });

  it("derives state from the steward self-report and escalation", () => {
    const fold = foldWith("march", {
      "ask-cut": { sliceId: "ask-cut", stage: "pr-open", stewardReport: { status: "awaiting_input", classified: true } },
      "err-cut": { sliceId: "err-cut", stage: "escalated", escalatedReason: "needs_human" },
      "disp-cut": { sliceId: "disp-cut", stage: "hatchery-pending" },
    });
    const rows = joinSessions(sources({ fold }), NOW);
    const byId = Object.fromEntries(rows.map((r) => [r.sliceId, r]));
    expect(byId["ask-cut"].state).toBe("waiting-on-approval");
    expect(byId["err-cut"].state).toBe("errored");
    expect(byId["err-cut"].escalatedReason).toBe("needs_human");
    expect(byId["disp-cut"].state).toBe("dispatched");
  });

  it("attaches a profile-less spawn record to its steward's row (Hatchery path)", () => {
    // Normal Hatchery registration: spawn row has NO profile, steward row carries
    // it. Both share the worktree. They must collapse into one row that keeps the
    // containerId — not split into a phantom profile="" orphan.
    const slice: SliceState = {
      sliceId: "p-cut",
      stage: "pr-open",
      branch: "feature/p",
      worktreePath: "/wt/p",
      sessionId: "stew-p",
    };
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "p-cut": slice }),
        castraByProfile: new Map([["march", [castra({ sessionId: "stew-p", worktreePath: "/wt/p", branch: "feature/p" })]]]),
        brood: [
          broodRecord({ id: "spawn-p", kind: "spawn", profile: undefined, containerId: "cidp123456789", worktreePath: "/wt/p" }),
          broodRecord({ id: "stew-p", kind: "steward", agentDeckSessionId: "stew-p", profile: "march", parentId: "spawn-p", worktreePath: "/wt/p" }),
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].divergence).toBe("ok");
    expect(rows[0].containerId).toBe("cidp123456789");
    expect(rows[0].profile).toBe("march");
  });

  it("collapses a pure Brood-only spawn+steward pair into one row (steward processed first)", () => {
    const rows = joinSessions(
      sources({
        brood: [
          broodRecord({ id: "spawn-q", kind: "spawn", profile: undefined, containerId: "cidq123456789", worktreePath: "/wt/q" }),
          broodRecord({ id: "stew-q", kind: "steward", agentDeckSessionId: "stew-q", profile: "march", worktreePath: "/wt/q", status: "running" }),
        ],
      }),
      NOW,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].profile).toBe("march");
    expect(rows[0].containerId).toBe("cidq123456789");
    expect(rows[0].divergence).toBe("brood-only");
  });

  it("flags a fold-only awaiting_input slice as stale (the operator can't attach to answer)", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", {
          "ask-cut": { sliceId: "ask-cut", stage: "pr-open", stewardReport: { status: "awaiting_input", classified: true } },
        }),
      }),
      NOW,
    );
    expect(rows[0].state).toBe("waiting-on-approval");
    expect(rows[0].divergence).toBe("fold-only");
  });

  it("lets escalated take precedence over an awaiting_input self-report in the state label", () => {
    const rows = joinSessions(
      sources({
        fold: foldWith("march", {
          "esc-cut": {
            sliceId: "esc-cut",
            stage: "escalated",
            escalatedReason: "steward_awaiting_input",
            stewardReport: { status: "awaiting_input", classified: true },
          },
        }),
      }),
      NOW,
    );
    expect(rows[0].state).toBe("errored"); // escalated wins
    expect(rows[0].stage).toBe("escalated");
    expect(rows[0].divergence).toBe("fold-only"); // awaiting_input still expects a session
  });

  it("does not mislabel a terminal `merged` slice as waiting-for-merge", () => {
    const rows = joinSessions(
      sources({ fold: foldWith("march", { "m-cut": { sliceId: "m-cut", stage: "merged" } }) }),
      NOW,
    );
    expect(rows[0].state).toBe("unknown");
    expect(rows[0].stage).toBe("merged"); // real stage still visible
    expect(rows[0].divergence).toBe("ok"); // not session-expected → not stale
  });

  it("skips operator-recovered (tombstoned) slices", () => {
    const rows = joinSessions(
      sources({ fold: foldWith("march", { "rec-cut": { sliceId: "rec-cut", recovered: true } }) }),
      NOW,
    );
    expect(rows).toHaveLength(0);
  });

  it("rejoins a relaunched session to its slice by branch even when the worktree changed", () => {
    const slice: SliceState = {
      sliceId: "relaunch-cut",
      stage: "implementing",
      branch: "feature/relaunch",
      worktreePath: "/wt/old",
    };
    const rows = joinSessions(
      sources({
        fold: foldWith("march", { "relaunch-cut": slice }),
        castraByProfile: new Map([
          ["march", [castra({ sessionId: "fresh", worktreePath: "/wt/new", branch: "feature/relaunch" })]],
        ]),
      }),
      NOW,
    );
    expect(rows).toHaveLength(1); // joined, not split
    expect(rows[0].castraSessionId).toBe("fresh");
  });

  it("computes age from the earliest known createdAt", () => {
    const rows = joinSessions(
      sources({
        castraByProfile: new Map([["march", [castra({ createdAt: "2026-06-16T11:00:00.000Z" })]]]),
      }),
      NOW,
    );
    expect(rows[0].ageMs).toBe(60 * 60 * 1000); // one hour
  });
});
