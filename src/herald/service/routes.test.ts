import { afterEach, describe, expect, it } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";
import { registerRoutes, validateEvent, type ObserveStatus } from "./routes.js";
import { sqliteAvailable } from "./sqlite.js";
import { EventStore } from "./store.js";

async function buildApp(
  getObserveStatus?: () => ObserveStatus,
): Promise<{ app: FastifyInstance; store: EventStore }> {
  const store = new EventStore({ dbPath: ":memory:" });
  const app = Fastify();
  await registerRoutes(app, { store, getObserveStatus });
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
