/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  buildEscalations,
  buildLoopServer,
  buildStatus,
  escalationsForWorkingState,
  resolveRequeueTarget,
  resolveRespondTarget,
  type LoopHttpContext,
  type RequeueInput,
  type RespondInput,
} from "./http.js";
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

describe("loop http /queue (#592)", () => {
  const rows = [{ path: "a.tasks.md", rowId: "S1", command: "smithy.forge", arguments: [], sliceId: "a-forge", branch: "b", decision: "archived_closed", heldBy: { sliceId: "a-forge", matchedOn: "id", prNumber: 333, terminal: "CLOSED" } }];
  const snap = () =>
    snapshot({
      byProfile: {
        march: {
          lastHeartbeat: heartbeat,
          workingState: { slices: {} },
          lastDispatch: { at: "2026-11-19T00:00:00.000Z", smithyOk: true, items: rows as any, checkout: { ok: true, behind: 0 } },
        },
        smithy: { lastHeartbeat: heartbeat, workingState: { slices: {} } },
      },
    });

  it("serves one profile's per-item decisions and checkout status", async () => {
    const app = buildLoopServer(ctxWith(snap()));
    try {
      const res = await app.inject({ method: "GET", url: "/queue?profile=march" });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        ok: true,
        profile: "march",
        last_tick_at: "2026-11-19T00:00:00.000Z",
        smithy_ok: true,
        queue: { dispatchable: 2, blocked: 1, total: 5 },
        items: rows,
        checkout: { ok: true, behind: 0 },
      });
    } finally {
      await app.close();
    }
  });

  it("serves every profile without ?profile, empty items before a tick", async () => {
    const app = buildLoopServer(ctxWith(snap()));
    try {
      const res = await app.inject({ method: "GET", url: "/queue" });
      expect(res.statusCode).toBe(200);
      expect(res.json().profiles).toEqual(["march", "smithy"]);
      expect(res.json().by_profile.smithy).toMatchObject({ items: [], smithy_ok: null, checkout: null });
    } finally {
      await app.close();
    }
  });

  it("404s an unknown profile with the known ones", async () => {
    const app = buildLoopServer(ctxWith(snap()));
    try {
      const res = await app.inject({ method: "GET", url: "/queue?profile=nope" });
      expect(res.statusCode).toBe(404);
      expect(res.json()).toMatchObject({ ok: false, profiles: ["march", "smithy"] });
    } finally {
      await app.close();
    }
  });
});

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

describe("resolveRespondTarget (pure)", () => {
  it("resolves a steward_awaiting_input slice to its session id", () => {
    expect(resolveRespondTarget(escalatedWorkingState, "spec-re-read-us1-s2-forge")).toEqual({
      ok: true,
      sessionId: "sess-1",
      reason: "steward_awaiting_input",
    });
  });

  it("yields a null sessionId when the slice has no worker session", () => {
    const ws = { slices: { x: { stage: "escalated", escalated_reason: "steward_awaiting_input" } } };
    expect(resolveRespondTarget(ws, "x")).toEqual({ ok: true, sessionId: null, reason: "steward_awaiting_input" });
  });

  it("rejects an unknown slice", () => {
    expect(resolveRespondTarget(escalatedWorkingState, "nope")).toMatchObject({ ok: false });
    expect((resolveRespondTarget(escalatedWorkingState, "nope") as any).error).toMatch(/unknown slice/);
  });

  it("rejects a non-escalated slice", () => {
    expect(resolveRespondTarget(escalatedWorkingState, "healthy-us1-s2-forge")).toMatchObject({ ok: false });
    expect((resolveRespondTarget(escalatedWorkingState, "healthy-us1-s2-forge") as any).error).toMatch(/not escalated/);
  });

  it("rejects an escalation that is not steward_awaiting_input (points at recover)", () => {
    const ws = { slices: { d: { stage: "escalated", escalated_reason: "hatchery_dispatch_failed" } } };
    const r = resolveRespondTarget(ws, "d") as any;
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/not steward_awaiting_input/);
    expect(r.error).toMatch(/march legate recover/);
  });
});

describe("POST /escalations/:sliceId/respond", () => {
  function ctxWithRespond(spy: (input: RespondInput) => void, result: any): LoopHttpContext {
    return {
      startedAtMs: Date.now() - 5000,
      getSnapshot: () => snapshot(),
      respondToEscalation: async (input) => {
        spy(input);
        return result;
      },
    };
  }

  it("answer mode: parses message + profile and returns the result (200)", async () => {
    let seen: RespondInput | null = null;
    const app = buildLoopServer(
      ctxWithRespond((i) => (seen = i), { ok: true, profile: "march", sliceId: "s1", mode: "answer", delivered: true, cleared: true }),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/escalations/s1/respond",
        payload: { profile: "march", message: "use option B" },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, mode: "answer", delivered: true, cleared: true });
      expect(seen).toEqual({ profile: "march", sliceId: "s1", message: "use option B", ack: false });
    } finally {
      await app.close();
    }
  });

  it("ack mode: no message, ack:true → marks read", async () => {
    let seen: RespondInput | null = null;
    const app = buildLoopServer(
      ctxWithRespond((i) => (seen = i), { ok: true, profile: "march", sliceId: "s1", mode: "ack", cleared: true }),
    );
    try {
      const res = await app.inject({
        method: "POST",
        url: "/escalations/s1/respond?profile=march",
        payload: { ack: true },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ ok: true, mode: "ack", cleared: true });
      expect(seen).toEqual({ profile: "march", sliceId: "s1", ack: true }); // profile read from query
    } finally {
      await app.close();
    }
  });

  it("400 when neither message nor ack is provided", async () => {
    const app = buildLoopServer(ctxWithRespond(() => {}, { ok: true }));
    try {
      const res = await app.inject({ method: "POST", url: "/escalations/s1/respond", payload: { profile: "march" } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/message.*or.*ack/i);
    } finally {
      await app.close();
    }
  });

  it("400 when BOTH message and ack are provided (ambiguous mode)", async () => {
    let called = false;
    const app = buildLoopServer(ctxWithRespond(() => (called = true), { ok: true }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/escalations/s1/respond",
        payload: { profile: "march", message: "do the thing", ack: true },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/exactly one/i);
      expect(called).toBe(false); // rejected before effecting anything
    } finally {
      await app.close();
    }
  });

  it("400 when profile is missing", async () => {
    const app = buildLoopServer(ctxWithRespond(() => {}, { ok: true }));
    try {
      const res = await app.inject({ method: "POST", url: "/escalations/s1/respond", payload: { ack: true } });
      expect(res.statusCode).toBe(400);
      expect(res.json().error).toMatch(/profile is required/);
    } finally {
      await app.close();
    }
  });

  it("501 when respond is not wired into the context", async () => {
    const app = buildLoopServer({ startedAtMs: Date.now(), getSnapshot: () => snapshot() });
    try {
      const res = await app.inject({ method: "POST", url: "/escalations/s1/respond", payload: { profile: "march", ack: true } });
      expect(res.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });

  it("maps an unknown-profile result to 404", async () => {
    const app = buildLoopServer(ctxWithRespond(() => {}, { ok: false, error: 'unknown profile "ghost".', profiles: ["smithy"] }));
    try {
      const res = await app.inject({ method: "POST", url: "/escalations/s1/respond", payload: { profile: "ghost", ack: true } });
      expect(res.statusCode).toBe(404);
    } finally {
      await app.close();
    }
  });

  it("maps a generic not-ok result to 400", async () => {
    const app = buildLoopServer(ctxWithRespond(() => {}, { ok: false, error: "slice has no steward session." }));
    try {
      const res = await app.inject({ method: "POST", url: "/escalations/s1/respond", payload: { profile: "march", message: "hi" } });
      expect(res.statusCode).toBe(400);
    } finally {
      await app.close();
    }
  });
});

describe("resolveRequeueTarget (#588)", () => {
  it("accepts any in-flight slice, whatever its stage, reason or session — incl. awaiting_input with a dead session", () => {
    const ws = { slices: { s: { stage: "escalated", worker_session_id: "dead" } } };
    expect(resolveRequeueTarget(ws, "s", false)).toEqual({ ok: true, openPr: null });
    expect(resolveRequeueTarget({ slices: { s: { stage: "implementing" } } }, "s", false)).toEqual({ ok: true, openPr: null });
  });

  it("404s an unknown slice and 409s an archived / recovered / spawning one", () => {
    expect(resolveRequeueTarget({ slices: {} }, "x", false)).toMatchObject({ ok: false, status: 404 });
    const archived = { slices: {}, archived_slices: { x: { terminal_state: "MERGED" } } };
    expect(resolveRequeueTarget(archived, "x", false)).toMatchObject({ ok: false, status: 409 });
    expect(resolveRequeueTarget({ slices: { x: { recovered: true } } }, "x", false)).toMatchObject({ ok: false, status: 409 });
    expect(resolveRequeueTarget({ slices: { x: { stage: "hatchery-pending" } } }, "x", false)).toMatchObject({ ok: false, status: 409 });
  });

  it("refuses an open PR unless closePr; refuses a merged PR; ignores a closed one", () => {
    const open = { slices: { s: { stage: "pr-open", pr: { number: 7, state: "OPEN" } } } };
    const r = resolveRequeueTarget(open, "s", false) as any;
    expect(r).toMatchObject({ ok: false, status: 409 });
    expect(r.error).toMatch(/closePr/);
    expect(resolveRequeueTarget(open, "s", true)).toEqual({ ok: true, openPr: 7 });
    const merged = { slices: { s: { pr: { number: 7, state: "MERGED" } } } };
    expect(resolveRequeueTarget(merged, "s", true)).toMatchObject({ ok: false, status: 409 });
    const closed = { slices: { s: { pr: { number: 7, state: "CLOSED" } } } };
    expect(resolveRequeueTarget(closed, "s", false)).toEqual({ ok: true, openPr: null });
  });
});

describe("POST /slices/:sliceId/requeue (#588)", () => {
  function ctxWithRequeue(spy: (input: RequeueInput) => void, result: any): LoopHttpContext {
    return {
      startedAtMs: Date.now() - 5000,
      getSnapshot: () => snapshot(),
      requeueSlice: async (input) => {
        spy(input);
        return result;
      },
    };
  }

  it("parses the body and returns 202 on an accepted request", async () => {
    let seen: RequeueInput | null = null;
    const app = buildLoopServer(ctxWithRequeue((i) => (seen = i), { ok: true, profile: "march", sliceId: "s1", requested: true, closesPr: null }));
    try {
      const res = await app.inject({
        method: "POST",
        url: "/slices/s1/requeue",
        payload: { profile: "march", operator: " jb ", reason: "asked then died" },
      });
      expect(res.statusCode).toBe(202);
      expect(res.json()).toMatchObject({ ok: true, requested: true });
      expect(seen).toEqual({ profile: "march", sliceId: "s1", closePr: false, operator: "jb", reason: "asked then died" });
    } finally {
      await app.close();
    }
  });

  it("accepts the profile from the query string", async () => {
    let seen: RequeueInput | null = null;
    const app = buildLoopServer(ctxWithRequeue((i) => (seen = i), { ok: true }));
    try {
      const res = await app.inject({ method: "POST", url: "/slices/s1/requeue?profile=march", payload: { closePr: true } });
      expect(res.statusCode).toBe(202);
      expect(seen).toMatchObject({ profile: "march", closePr: true });
    } finally {
      await app.close();
    }
  });

  it("400s a missing profile or badly typed fields, without calling the runtime", async () => {
    let called = false;
    const app = buildLoopServer(ctxWithRequeue(() => (called = true), { ok: true }));
    try {
      for (const payload of [{}, { profile: "march", closePr: "yes" }, { profile: "march", reason: 3 }]) {
        const res = await app.inject({ method: "POST", url: "/slices/s1/requeue", payload });
        expect(res.statusCode).toBe(400);
      }
      expect(called).toBe(false);
    } finally {
      await app.close();
    }
  });

  it("maps a runtime refusal to its status (409 open PR, 404 unknown)", async () => {
    const conflict = buildLoopServer(ctxWithRequeue(() => {}, { ok: false, status: 409, error: "open PR #7" }));
    const missing = buildLoopServer(ctxWithRequeue(() => {}, { ok: false, status: 404, error: "unknown slice" }));
    try {
      expect((await conflict.inject({ method: "POST", url: "/slices/s1/requeue", payload: { profile: "march" } })).statusCode).toBe(409);
      expect((await missing.inject({ method: "POST", url: "/slices/s1/requeue", payload: { profile: "march" } })).statusCode).toBe(404);
    } finally {
      await conflict.close();
      await missing.close();
    }
  });

  it("501s when the runtime does not provide requeue", async () => {
    const app = buildLoopServer({ startedAtMs: Date.now(), getSnapshot: () => snapshot() });
    try {
      const res = await app.inject({ method: "POST", url: "/slices/s1/requeue", payload: { profile: "march" } });
      expect(res.statusCode).toBe(501);
    } finally {
      await app.close();
    }
  });
});
