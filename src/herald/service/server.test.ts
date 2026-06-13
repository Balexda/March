/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { sqliteAvailable } from "./sqlite.js";
import { EventStore } from "./store.js";

describe.skipIf(!sqliteAvailable)("buildServer", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("builds an app wired to the provided store and serves /healthz", async () => {
    const store = new EventStore({ dbPath: ":memory:" });
    const { app, store: wired } = await buildServer({ store });
    close = async () => {
      await app.close();
      store.close();
    };
    expect(wired).toBe(store);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("serves appended events end-to-end through the app", async () => {
    const store = new EventStore({ dbPath: ":memory:" });
    const { app } = await buildServer({ store });
    close = async () => {
      await app.close();
      store.close();
    };
    await app.inject({
      method: "POST",
      url: "/events",
      payload: { source: "legate", type: "slice.stage.changed", sliceId: "s1", stage: "pr-open" },
    });
    const page = await app.inject({ method: "GET", url: "/events?after=0" });
    expect(page.json().events).toHaveLength(1);
    const state = await app.inject({ method: "GET", url: "/state" });
    expect(state.json().slices.s1.stage).toBe("pr-open");
  });

  it("listens on an ephemeral port and serves /healthz over real HTTP", async () => {
    const store = new EventStore({ dbPath: ":memory:" });
    const { app } = await buildServer({ store });
    const address = await app.listen({ port: 0, host: "127.0.0.1" });
    close = async () => {
      await app.close();
      store.close();
    };
    const res = await fetch(`${address}/healthz`);
    expect(res.status).toBe(200);
  });
});
