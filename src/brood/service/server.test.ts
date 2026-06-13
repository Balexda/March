/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";

describe.skipIf(!sqliteAvailable)("buildServer", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  it("builds an app wired to the provided store and serves /healthz", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const { app, store: wired } = await buildServer({ store });
    close = async () => {
      await app.close();
      store.close();
    };
    expect(wired).toBe(store);
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
  });

  it("serves registered sessions end-to-end through the app", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    const { app } = await buildServer({ store });
    close = async () => {
      await app.close();
      store.close();
    };
    await app.inject({
      method: "POST",
      url: "/sessions",
      payload: { id: "s1", kind: "spawn" },
    });
    const list = await app.inject({ method: "GET", url: "/sessions" });
    expect(list.json().sessions).toHaveLength(1);
  });
});
