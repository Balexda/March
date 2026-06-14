/**
 * @l1 @deterministic @ci
 */
import { afterEach, describe, expect, it } from "vitest";
import { initOtel } from "../../observability/otel.js";
import type { BroodReapConfig } from "../config.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import type { CastraSession } from "../../castra/types.js";
import type { CastraStewardGateway, OrphanGate } from "./steward-removal.js";
import { startBroodReconciler } from "./reconciler.js";

/** Castra gateway that records list reads + removals over a fixed session list. */
function recordingGateway(
  sessions: CastraSession[] = [],
): CastraStewardGateway & { listed: number; removed: string[] } {
  const removed: string[] = [];
  return {
    listed: 0,
    removed,
    async listSessions() {
      this.listed++;
      return sessions;
    },
    async removeSession({ sessionId }) {
      removed.push(sessionId);
      return { removed: true };
    },
  };
}

function reapConfig(over: Partial<BroodReapConfig> = {}): BroodReapConfig {
  const reapEnabled = over.reapEnabled ?? false;
  const adoptEnabled = over.adoptEnabled ?? false;
  return {
    reapEnabled,
    adoptEnabled,
    active: over.active ?? (reapEnabled || adoptEnabled),
    intervalMs: over.intervalMs ?? 999_999,
    deadOrphanAgeMs: over.deadOrphanAgeMs ?? 24 * 3_600_000,
  };
}

/** Spin the event loop until `cond` holds or the attempt budget is exhausted. */
async function waitFor(cond: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries; i++) {
    if (cond()) return;
    await new Promise((r) => setImmediate(r));
  }
}

function castraSession(over: Partial<CastraSession> & { sessionId: string }): CastraSession {
  return {
    sessionId: over.sessionId,
    title: "",
    group: "",
    branch: over.branch ?? "",
    worktreePath: over.worktreePath ?? "",
    createdAt: over.createdAt ?? "",
    status: over.status ?? "waiting",
  };
}

describe.skipIf(!sqliteAvailable)("startBroodReconciler", () => {
  afterEach(() => initOtel({}));

  it("returns a no-op stopper and never observes when telemetry is disabled", () => {
    initOtel({});
    const gw = recordingGateway();
    const store = new SessionStore({ dbPath: ":memory:" });
    const stop = startBroodReconciler(store, { gateway: gw, intervalMs: 999_999 });
    expect(typeof stop).toBe("function");
    expect(gw.listed).toBe(0);
    expect(() => stop()).not.toThrow();
    store.close();
  });

  it("observes immediately when telemetry is enabled", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const gw = recordingGateway();
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "s",
      kind: "steward",
      profile: "march",
      repoPath: "/repo",
      worktreePath: "/wt/a",
      status: "running",
    });
    const stop = startBroodReconciler(store, { gateway: gw, intervalMs: 999_999 });
    await waitFor(() => gw.listed >= 1);
    expect(gw.listed).toBeGreaterThanOrEqual(1);
    stop();
    store.close();
  });

  it("does NOT reap when both auto-reconcile flags are off (observe-only)", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/y",
      status: "torndown",
    });
    const gw = recordingGateway([
      castraSession({ sessionId: "leaked", worktreePath: "/wt/gone", branch: "feature/y" }),
    ]);
    const gate: OrphanGate = {
      worktreeExists: (p) => p !== "/wt/gone",
      branchPrState: async () => "unknown",
    };
    const stop = startBroodReconciler(store, {
      gateway: gw,
      intervalMs: 999_999,
      reap: reapConfig(), // inactive
      gate,
    });
    // Let the observe loop run a bit; the reap loop must not have started.
    await waitFor(() => gw.listed >= 1);
    expect(gw.removed).toEqual([]);
    stop();
    store.close();
  });

  it("runs the reap loop and reaps a confirmed-done orphan when armed", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/y",
      status: "torndown",
    });
    const gw = recordingGateway([
      castraSession({ sessionId: "leaked", worktreePath: "/wt/gone", branch: "feature/y" }),
    ]);
    const gate: OrphanGate = {
      worktreeExists: (p) => p !== "/wt/gone",
      branchPrState: async () => "unknown",
    };
    const stop = startBroodReconciler(store, {
      gateway: gw,
      intervalMs: 999_999,
      reap: reapConfig({ reapEnabled: true }),
      gate,
    });
    await waitFor(() => gw.removed.length > 0);
    expect(gw.removed).toEqual(["leaked"]);
    stop();
    store.close();
  });

  it("runs the reap loop and adopts an open-PR orphan when adopt is armed", async () => {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/x",
      status: "torndown",
    });
    const gw = recordingGateway([
      castraSession({ sessionId: "live", worktreePath: "/wt/new", branch: "feature/open" }),
    ]);
    const gate: OrphanGate = {
      worktreeExists: () => true,
      branchPrState: async () => "open",
    };
    const stop = startBroodReconciler(store, {
      gateway: gw,
      intervalMs: 999_999,
      reap: reapConfig({ adoptEnabled: true }),
      gate,
    });
    await waitFor(() => store.get("live") !== undefined);
    expect(gw.removed).toEqual([]); // adopted, never removed
    expect(store.get("live")).toMatchObject({ kind: "steward", status: "running" });
    stop();
    store.close();
  });
});
