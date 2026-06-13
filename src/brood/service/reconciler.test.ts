/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "../../observability/otel.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import type { CastraStewardGateway } from "./steward-removal.js";
import { startBroodReconciler } from "./reconciler.js";

/** Castra gateway that records how many times its session list was read. */
function countingGateway(): CastraStewardGateway & { listed: number } {
  return {
    listed: 0,
    async listSessions() {
      this.listed++;
      return [];
    },
    async removeSession() {
      return { removed: true };
    },
  };
}

describe.skipIf(!sqliteAvailable)("startBroodReconciler", () => {
  afterEach(() => initOtel({}));

  it("returns a no-op stopper and never observes when telemetry is disabled", () => {
    initOtel({});
    const gw = countingGateway();
    const store = new SessionStore({ dbPath: ":memory:" });
    const stop = startBroodReconciler(store, gw, 999_999);
    expect(typeof stop).toBe("function");
    expect(gw.listed).toBe(0);
    expect(() => stop()).not.toThrow();
    store.close();
  });

  it("observes immediately when telemetry is enabled", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const gw = countingGateway();
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "s",
      kind: "steward",
      profile: "march",
      repoPath: "/repo",
      worktreePath: "/wt/a",
      status: "running",
    });
    const stop = startBroodReconciler(store, gw, 999_999);
    // The immediate `void run()` is async; let its microtasks settle.
    await new Promise((r) => setImmediate(r));
    expect(gw.listed).toBeGreaterThanOrEqual(1);
    stop();
    store.close();
  });
});
