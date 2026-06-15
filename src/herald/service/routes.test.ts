/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes, validateEvent, type ObserveStatus } from "./routes.js";
import { sqliteAvailable } from "./sqlite.js";
import { EventStore } from "./store.js";

async function buildApp(
  getObserveStatus?: () => ObserveStatus,
  env?: NodeJS.ProcessEnv,
): Promise<{ app: FastifyInstance; store: EventStore }> {
  const store = new EventStore({ dbPath: ":memory:" });
  const app = Fastify();
  await registerRoutes(app, { store, getObserveStatus, env });
  return { app, store };
}

describe("validateEvent", () => {
  it("rejects an unknown type", () => {
    expect(validateEvent({ type: "nope" })).toMatchObject({ ok: false });
  });
  it("requires sliceId for slice events", () => {
    expect(validateEvent({ type: "slice.stage.changed", stage: "x" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "x" })).toMatchObject({ ok: true });
  });
  it("requires session.id for session.changed", () => {
    expect(validateEvent({ type: "session.changed", session: {} })).toMatchObject({ ok: false });
  });
  it("accepts an optional sessionId on slice.stage.changed, rejecting empty/whitespace/non-string (#210)", () => {
    const ok = validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: "sess-9" });
    expect(ok).toMatchObject({ ok: true });
    expect(ok.ok && (ok.input as { sessionId?: string }).sessionId).toBe("sess-9");
    expect(validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: "" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: "   " })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: 42 as unknown as string })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.stage.changed", sliceId: "s1", stage: "implementing", sessionId: {} as unknown as string })).toMatchObject({ ok: false });
  });
  it("validates sessionId consistently across every transition type that carries it (#210)", () => {
    // The check is centralized, so slice.dispatched / steward.relaunched are guarded too.
    expect(validateEvent({ type: "slice.dispatched", sliceId: "s1", sessionId: "" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "steward.relaunched", sliceId: "s1", sessionId: 7 as unknown as string })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.dispatched", sliceId: "s1", sessionId: "sess-9" })).toMatchObject({ ok: true });
    // Absent sessionId is still fine (it is optional on these events).
    expect(validateEvent({ type: "slice.dispatched", sliceId: "s1" })).toMatchObject({ ok: true });
  });
  it("requires sliceId + sessionId for slice.steward.attached (#213)", () => {
    expect(validateEvent({ type: "slice.steward.attached", sessionId: "x" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.steward.attached", sliceId: "s1" })).toMatchObject({ ok: false });
    expect(
      validateEvent({ type: "slice.steward.attached", sliceId: "s1", sessionId: "x", spawnId: "sp" }),
    ).toMatchObject({ ok: true });
  });
  it("accepts slice.recovery.requested with a sliceId, rejects it without (#238)", () => {
    expect(validateEvent({ type: "slice.recovery.requested" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.recovery.requested", sliceId: "" })).toMatchObject({ ok: false });
    expect(validateEvent({ type: "slice.recovery.requested", sliceId: "s1" })).toMatchObject({ ok: true });
  });
  it("forces source to legate (cannot spoof a herald observation event)", () => {
    const v = validateEvent({ type: "heartbeat" });
    expect(v.ok && v.input.source).toBe("legate");
    const spoof = validateEvent({ type: "slice.pr.changed", sliceId: "s1", pr: {}, source: "herald" });
    expect(spoof.ok && spoof.input.source).toBe("legate");
  });
});

describe.skipIf(!sqliteAvailable)("herald routes", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("GET /events validates after/limit and returns events + lastSeq", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    store.append({ source: "herald", type: "heartbeat" });
    store.append({ source: "herald", type: "heartbeat" });

    const ok = await app.inject({ method: "GET", url: "/events?after=0&limit=10" });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().lastSeq).toBe(2);
    expect(ok.json().events).toHaveLength(2);

    expect((await app.inject({ method: "GET", url: "/events?after=-1" })).statusCode).toBe(400);
    expect((await app.inject({ method: "GET", url: "/events?limit=0" })).statusCode).toBe(400);
  });

  it("POST /events appends and returns 201 with an assigned seq", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    const res = await app.inject({
      method: "POST",
      url: "/events",
      payload: { source: "legate", type: "slice.dispatched", sliceId: "s1", branch: "feature/a" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().seq).toBe(1);

    const bad = await app.inject({ method: "POST", url: "/events", payload: { type: "bogus" } });
    expect(bad.statusCode).toBe(400);
  });

  it("POST /steward-report records a steward self-report event", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    const res = await app.inject({
      method: "POST",
      url: "/steward-report",
      payload: { profile: "march", sliceId: "s1", classified: true, status: "awaiting_input", summary: "How should I resolve …?" },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ type: "slice.steward.report", sliceId: "s1", status: "awaiting_input", classified: true });
    // It lands in the event stream the legate drains.
    expect(store.readAfter(0, 10).some((e) => e.type === "slice.steward.report")).toBe(true);
  });

  it("POST /steward-report rejects missing fields and a bad status", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    const noSlice = await app.inject({ method: "POST", url: "/steward-report", payload: { profile: "march", classified: true } });
    expect(noSlice.statusCode).toBe(400);
    const noClass = await app.inject({ method: "POST", url: "/steward-report", payload: { profile: "march", sliceId: "s1" } });
    expect(noClass.statusCode).toBe(400);
    const badStatus = await app.inject({ method: "POST", url: "/steward-report", payload: { profile: "march", sliceId: "s1", classified: true, status: "bogus" } });
    expect(badStatus.statusCode).toBe(400);
  });

  it("GET /state returns the projection and honors ?at=", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    store.append({ source: "herald", type: "smithy.queue.changed", dispatchable: 1, blocked: 0, total: 1 });
    store.append({ source: "herald", type: "smithy.queue.changed", dispatchable: 9, blocked: 0, total: 9 });

    expect((await app.inject({ method: "GET", url: "/state" })).json().smithy.dispatchable).toBe(9);
    expect((await app.inject({ method: "GET", url: "/state?at=1" })).json().smithy.dispatchable).toBe(1);
    expect((await app.inject({ method: "GET", url: "/state?at=-1" })).statusCode).toBe(400);
  });

  it("GET /state/delta returns (from,to] events and 400 on from>to", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    for (let i = 0; i < 3; i++) store.append({ source: "herald", type: "heartbeat" });
    const delta = await app.inject({ method: "GET", url: "/state/delta?from=1&to=3" });
    expect(delta.json().events.map((e: any) => e.seq)).toEqual([2, 3]);
    expect((await app.inject({ method: "GET", url: "/state/delta?from=5&to=1" })).statusCode).toBe(400);
  });

  it("GET /status summarizes the projection + observe snapshot", async () => {
    const { app, store } = await buildApp(() => ({ lastObserveAtMs: Date.now(), lastObserveDurationMs: 42 }));
    close = async () => { await app.close(); store.close(); };
    store.append({ source: "herald", type: "slice.pr.changed", sliceId: "s1", pr: { state: "OPEN" } });
    const status = (await app.inject({ method: "GET", url: "/status" })).json();
    expect(status.ok).toBe(true);
    expect(status.event_count).toBe(1);
    expect(status.last_seq).toBe(1);
    expect(status.slices_observed).toBe(1);
    expect(status.last_observe_duration_ms).toBe(42);
  });

  it("GET /readyz reports tool availability", async () => {
    const { app, store } = await buildApp();
    close = async () => { await app.close(); store.close(); };
    const res = await app.inject({ method: "GET", url: "/readyz" });
    expect([200, 503]).toContain(res.statusCode);
    expect(res.json()).toHaveProperty("git");
    expect(res.json()).toHaveProperty("smithy");
  });
});

describe.skipIf(!sqliteAvailable)("POST /admin/events (#265)", () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  const stewardEvent = {
    type: "slice.steward.attached",
    sliceId: "01-spawn-f5-s2-cut",
    sessionId: "e3bde73d-1779515948",
    worktreePath: "/home/op/wt/feature-x",
    branch: "smithy/cut/01-spawn-f5-s2",
  };
  const adminBody = (event: Record<string, unknown> = stewardEvent) => ({
    profile: "march",
    event,
    operator: "jmbattista",
    note: "legacy slice pre-#213; unstick PR #240",
  });

  it("404s (invisible) when MARCH_HERALD_ADMIN_TOKEN is unset — not 401", async () => {
    const { app, store } = await buildApp(undefined, {});
    close = async () => { await app.close(); store.close(); };
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer anything" },
      payload: adminBody(),
    });
    expect(res.statusCode).toBe(404);
    expect(store.count()).toBe(0);
  });

  it("401s when the token is set but the Bearer is missing or wrong", async () => {
    const { app, store } = await buildApp(undefined, { MARCH_HERALD_ADMIN_TOKEN: "s3cret" });
    close = async () => { await app.close(); store.close(); };
    const missing = await app.inject({ method: "POST", url: "/admin/events", payload: adminBody() });
    expect(missing.statusCode).toBe(401);
    const wrong = await app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer nope" },
      payload: adminBody(),
    });
    expect(wrong.statusCode).toBe(401);
    expect(store.count()).toBe(0);
  });

  it("200s on a valid event: appends with audit columns + a paired audit row", async () => {
    const { app, store } = await buildApp(undefined, { MARCH_HERALD_ADMIN_TOKEN: "s3cret" });
    close = async () => { await app.close(); store.close(); };
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer s3cret" },
      payload: adminBody(),
    });
    expect(res.statusCode).toBe(200);
    const { seq, auditSeq } = res.json();
    expect(seq).toBe(1);
    expect(auditSeq).toBe(2);

    // Two rows: the corrective event + its paired audit row.
    expect(store.count()).toBe(2);
    const events = store.readAfter(0, 10);
    const corrective = events.find((e) => e.seq === seq)!;
    expect(corrective.type).toBe("slice.steward.attached");
    // Audit columns are surfaced on the corrective row.
    expect(corrective.admin).toBe(true);
    expect(corrective.operator).toBe("jmbattista");
    expect(corrective.note).toContain("unstick PR #240");
    // It folds: worker session is now populated in the projection.
    expect(store.projectionFor("march").slices["01-spawn-f5-s2-cut"].sessionId).toBe(
      "e3bde73d-1779515948",
    );

    // The paired audit row references the appended seq and is reducer-inert.
    const audit = events.find((e) => e.seq === auditSeq)! as unknown as {
      type: string;
      appendedSeq: number;
      operator: string;
      note: string;
    };
    expect(audit.type).toBe("admin.event.appended");
    expect(audit.appendedSeq).toBe(seq);
    expect(audit.operator).toBe("jmbattista");
  });

  it("422s on a malformed event with the validator message", async () => {
    const { app, store } = await buildApp(undefined, { MARCH_HERALD_ADMIN_TOKEN: "s3cret" });
    close = async () => { await app.close(); store.close(); };
    // slice.steward.attached requires a non-empty sessionId.
    const res = await app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer s3cret" },
      payload: adminBody({ type: "slice.steward.attached", sliceId: "s1" }),
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatch(/sessionId/);
    // An out-of-taxonomy type is rejected too (the audit type can't be authored).
    const audit = await app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer s3cret" },
      payload: adminBody({ type: "admin.event.appended", appendedSeq: 1, operator: "x", note: "y" }),
    });
    expect(audit.statusCode).toBe(422);
    expect(store.count()).toBe(0);
  });

  it("folds identically to the same event posted via POST /events", async () => {
    // Via the admin break-glass endpoint.
    const admin = await buildApp(undefined, { MARCH_HERALD_ADMIN_TOKEN: "s3cret" });
    // Via the normal legate write path.
    const legate = await buildApp(undefined, {});
    close = async () => {
      await admin.app.close();
      admin.store.close();
      await legate.app.close();
      legate.store.close();
    };

    const adminRes = await admin.app.inject({
      method: "POST",
      url: "/admin/events",
      headers: { authorization: "Bearer s3cret" },
      payload: adminBody(),
    });
    expect(adminRes.statusCode).toBe(200);
    const legateRes = await legate.app.inject({
      method: "POST",
      url: "/events",
      payload: { source: "legate", profile: "march", ...stewardEvent },
    });
    expect(legateRes.statusCode).toBe(201);

    // The slice projection (envelope-independent) is identical — the corrective
    // event reduces by its own type, and the paired audit row is reducer-inert.
    const adminSlice = admin.store.projectionFor("march").slices["01-spawn-f5-s2-cut"];
    const legateSlice = legate.store.projectionFor("march").slices["01-spawn-f5-s2-cut"];
    expect(adminSlice).toEqual(legateSlice);
  });

  it("422s when profile/operator/note are missing", async () => {
    const { app, store } = await buildApp(undefined, { MARCH_HERALD_ADMIN_TOKEN: "s3cret" });
    close = async () => { await app.close(); store.close(); };
    for (const bad of [
      { event: stewardEvent, operator: "x", note: "y" }, // no profile
      { profile: "march", event: stewardEvent, note: "y" }, // no operator
      { profile: "march", event: stewardEvent, operator: "x" }, // no note
    ]) {
      const res = await app.inject({
        method: "POST",
        url: "/admin/events",
        headers: { authorization: "Bearer s3cret" },
        payload: bad,
      });
      expect(res.statusCode).toBe(422);
    }
    expect(store.count()).toBe(0);
  });
});
