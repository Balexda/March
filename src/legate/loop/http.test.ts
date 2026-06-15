/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import { buildEscalations, buildLoopServer, buildStatus, escalationsForWorkingState, type LoopHttpContext } from "./http.js";
import type { LoopSnapshot } from "./runtime.js";

const heartbeat = {
  ts: "2026-05-19T00:00:00.000Z",
  slice_count: 4,
  archived_slice_count: 2,
  workers: { running: 1, idle: 2, error: 0 },
  cleanup_count: 1,
  ghost_cleanup_count: 0,
  relaunch_count: 0,
  babysit_action_count: 3,
  steward_nudge_count: 12,
  steward_stranded_count: 2,
  dispatch_action_count: 2,
  dispatch_failure_count: 1,
  dispatchable_count: 2,
  blocked_count: 1,
  pending_total: 5,
  state_present: true,
  state_error: null,
};

function snapshot(over: Partial<LoopSnapshot> = {}): LoopSnapshot {
  const byProfile = over.byProfile ?? { smithy: { lastHeartbeat: heartbeat, workingState: { slices: {} } } };
  return {
    byProfile,
    profiles: over.profiles ?? Object.keys(byProfile),
    lastTickAtMs: over.lastTickAtMs ?? Date.now(),
    lastTickDurationMs: over.lastTickDurationMs ?? 420,
    lastHeartbeat: over.lastHeartbeat ?? Object.values(byProfile)[0]?.lastHeartbeat ?? null,
  };
}

function ctxWith(snap: LoopSnapshot): LoopHttpContext {
  return { startedAtMs: Date.now() - 5000, getSnapshot: () => snap };
}

describe("loop http (fastify)", () => {
  it("builds a per-profile /status payload from that profile's heartbeat", () => {
    const status = buildStatus(ctxWith(snapshot()), "smithy");
    expect(status).toMatchObject({
      ok: true,
      profile: "smithy",
      queue: { dispatchable: 2, blocked: 1, total: 5 },
      slices: { total: 4, archived: 2 },
      last_tick_duration_ms: 420,
      counters: { dispatch: 2, dispatch_failure: 1, babysit: 3, cleanup: 1, steward_nudge: 12, steward_stranded: 2 },
      state_present: true,
    });
  });

  it("bare /status returns the per-profile breakdown", () => {
    const status = buildStatus(ctxWith(snapshot()));
    expect(status).toMatchObject({ ok: true, profiles: ["smithy"] });
    expect((status as any).by_profile.smithy.queue.dispatchable).toBe(2);
  });

  it("an unknown profile reports not-ok with the known profile list", () => {
    const status = buildStatus(ctxWith(snapshot()), "ghost");
    expect(status).toMatchObject({ ok: false, profiles: ["smithy"] });
  });

  it("returns safe defaults before the first tick", () => {
    const status = buildStatus(
      ctxWith(snapshot({ byProfile: { smithy: { lastHeartbeat: null, workingState: null } }, lastTickAtMs: 0, lastTickDurationMs: 0 })),
      "smithy",
    );
    expect(status).toMatchObject({
      queue: { dispatchable: 0, blocked: 0, total: 0 },
      last_tick_at: null,
      last_tick_age_seconds: null,
    });
  });

  it("serves /healthz and /status, 404 for unknown routes", async () => {
    const app = buildLoopServer(ctxWith(snapshot({ lastTickDurationMs: 1 })));
    try {
      const health = await app.inject({ method: "GET", url: "/healthz" });
      expect(health.statusCode).toBe(200);
      expect(health.json().status).toBe("ok");
      expect(health.json().profiles).toEqual(["smithy"]);

      const status = await app.inject({ method: "GET", url: "/status?profile=smithy" });
      expect(status.statusCode).toBe(200);
      expect(status.json().queue.dispatchable).toBe(2);

      const missing = await app.inject({ method: "GET", url: "/nope" });
      expect(missing.statusCode).toBe(404);

      const wrongMethod = await app.inject({ method: "POST", url: "/status" });
      expect(wrongMethod.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });
});

const escalatedWorkingState = {
  slices: {
    // Steward parked on Claude's interactive prompt awaiting the user → escalated.
    "spec-re-read-us1-s2-forge": {
      stage: "escalated",
      escalated_reason: "steward_awaiting_input",
      branch: "feature/smithy/forge/x",
      actual_branch: "feature/smithy/forge/x",
      worker_session_id: "sess-1",
      worktree_path: "/wt/x",
      pr: { number: 346, url: "https://github.com/Balexda/SmithyCLI/pull/346" },
      last_action_note: 'Steward is parked on an interactive prompt awaiting your selection: "How should I resolve …?".',
      steward_awaiting_input_at: "2026-06-14T08:00:00.000Z",
    },
    "healthy-us1-s2-forge": { stage: "pr-open", pr: { number: 12 } }, // not escalated → excluded
  },
};

describe("escalationsForWorkingState (pure)", () => {
  it("returns escalated slices with session+worktree+reason so the operator can find them", () => {
    expect(escalationsForWorkingState(escalatedWorkingState)).toEqual([
      {
        task: "spec-re-read-us1-s2-forge",
        branch: "feature/smithy/forge/x",
        pr: { number: 346, url: "https://github.com/Balexda/SmithyCLI/pull/346" },
        reason: "steward_awaiting_input",
        session_id: "sess-1",
        worktree_path: "/wt/x",
        detail: 'Steward is parked on an interactive prompt awaiting your selection: "How should I resolve …?".',
        escalated_at: "2026-06-14T08:00:00.000Z",
      },
    ]);
  });

  it("is safe on a null/empty working state (cold start)", () => {
    expect(escalationsForWorkingState(null)).toEqual([]);
    expect(escalationsForWorkingState({ slices: {} })).toEqual([]);
  });
});

describe("buildEscalations + /escalations route", () => {
  const snap = snapshot({ byProfile: { smithy: { lastHeartbeat: heartbeat, workingState: escalatedWorkingState } } });

  it("lists a profile's escalated tasks with the reason + session to find them", () => {
    const out = buildEscalations(ctxWith(snap), "smithy") as any;
    expect(out.ok).toBe(true);
    expect(out.count).toBe(1);
    expect(out.escalations[0]).toMatchObject({ reason: "steward_awaiting_input", session_id: "sess-1", pr: { number: 346 } });
  });

  it("unknown profile reports not-ok with the known list", () => {
    expect(buildEscalations(ctxWith(snap), "ghost")).toMatchObject({ ok: false, profiles: ["smithy"] });
  });

  it("serves GET /escalations?profile=", async () => {
    const app = buildLoopServer(ctxWith(snap));
    try {
      const res = await app.inject({ method: "GET", url: "/escalations?profile=smithy" });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(1);
      expect(res.json().escalations[0].session_id).toBe("sess-1"); // operator can find the session
    } finally {
      await app.close();
    }
  });
});
