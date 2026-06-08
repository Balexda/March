import { describe, expect, it } from "vitest";
import type { CastraSession } from "../../castra/types.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import {
  removeStewardViaCastra,
  sweepLeakedStewards,
  type CastraStewardGateway,
} from "./steward-removal.js";

function session(over: Partial<CastraSession> & { sessionId: string }): CastraSession {
  return {
    sessionId: over.sessionId,
    title: over.title ?? "",
    group: over.group ?? "",
    branch: over.branch ?? "",
    worktreePath: over.worktreePath ?? "",
    createdAt: over.createdAt ?? "",
    status: over.status ?? "waiting",
  };
}

/** Fake Castra gateway over an in-memory session list, recording removals. */
function fakeGateway(
  sessions: CastraSession[],
  opts: { listThrows?: boolean; removeThrows?: (id: string) => boolean } = {},
): CastraStewardGateway & { removed: string[]; sessions: CastraSession[] } {
  const removed: string[] = [];
  return {
    sessions,
    removed,
    async listSessions() {
      if (opts.listThrows) throw new Error("Could not reach Castra");
      return sessions;
    },
    async removeSession({ sessionId }) {
      if (opts.removeThrows?.(sessionId)) {
        throw new Error(`agent-deck remove ${sessionId} failed`);
      }
      const idx = sessions.findIndex((s) => s.sessionId === sessionId);
      if (idx === -1) return { removed: false };
      sessions.splice(idx, 1);
      removed.push(sessionId);
      return { removed: true };
    },
  };
}

describe("removeStewardViaCastra", () => {
  it("removes the real session matched by exact worktree even when the tracked id is stale", async () => {
    // The legate relaunched the steward → Castra keyed it under a NEW id while
    // Brood still tracks the OLD one. Worktree match finds the live session.
    const gw = fakeGateway([
      session({ sessionId: "new-id", worktreePath: "/wt/aaa", branch: "feature/x" }),
    ]);

    const res = await removeStewardViaCastra(gw, {
      sessionId: "stale-old-id",
      profile: "smithy",
      worktreePath: "/wt/aaa",
      branch: "feature/x",
    });

    expect(res.outcome).toBe("removed");
    expect(res.removedIds).toEqual(["new-id"]);
    expect(gw.removed).toEqual(["new-id"]);
  });

  it("reports absent only when Castra is reachable and has no matching session", async () => {
    const gw = fakeGateway([
      session({ sessionId: "other", worktreePath: "/wt/zzz" }),
    ]);

    const res = await removeStewardViaCastra(gw, {
      sessionId: "gone",
      profile: "smithy",
      worktreePath: "/wt/aaa",
    });

    expect(res.outcome).toBe("absent");
    expect(gw.removed).toEqual([]);
  });

  it("defers (failed) when Castra is unreachable — never reports a false absent", async () => {
    const gw = fakeGateway([], { listThrows: true });

    const res = await removeStewardViaCastra(gw, {
      sessionId: "x",
      profile: "smithy",
      worktreePath: "/wt/aaa",
    });

    expect(res.outcome).toBe("failed");
    expect(res.detail).toContain("castra list failed");
  });

  it("defers (failed) when a matched session's removal errors (still live)", async () => {
    const gw = fakeGateway(
      [session({ sessionId: "live", worktreePath: "/wt/aaa" })],
      { removeThrows: (id) => id === "live" },
    );

    const res = await removeStewardViaCastra(gw, {
      sessionId: "live",
      profile: "smithy",
      worktreePath: "/wt/aaa",
    });

    expect(res.outcome).toBe("failed");
    expect(res.detail).toContain("castra remove");
  });

  it("falls back to the tracked id when no worktree is known", async () => {
    const gw = fakeGateway([session({ sessionId: "ad-123" })]);

    const res = await removeStewardViaCastra(gw, {
      sessionId: "ad-123",
      profile: "smithy",
    });

    expect(res.outcome).toBe("removed");
    expect(gw.removed).toEqual(["ad-123"]);
  });
});

describe.skipIf(!sqliteAvailable)("sweepLeakedStewards", () => {
  it("reaps a Castra session whose worktree belongs to a torndown Brood row", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "spawn-1",
      kind: "spawn",
      status: "torndown",
      repoPath: "/repo",
      branch: "feature/x",
      worktreePath: "/wt/aaa",
    });
    store.register({
      id: "steward-old",
      kind: "steward",
      parentId: "spawn-1",
      agentDeckSessionId: "steward-old",
      profile: "smithy",
      worktreePath: "/wt/aaa",
      branch: "feature/x",
      status: "torndown",
    });

    // Castra still holds a leaked session for that worktree (under a fresh id).
    const gw = fakeGateway([
      session({ sessionId: "leaked-new", worktreePath: "/wt/aaa", branch: "feature/x" }),
      session({ sessionId: "unrelated", worktreePath: "/wt/live" }),
    ]);

    const result = await sweepLeakedStewards(store, gw);

    expect(result.reaped.map((r) => r.sessionId)).toEqual(["leaked-new"]);
    expect(gw.removed).toEqual(["leaked-new"]);
    expect(gw.sessions.map((s) => s.sessionId)).toEqual(["unrelated"]);
    store.close();
  });

  it("records a per-profile failure when Castra is unreachable and keeps going", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "steward-x",
      kind: "steward",
      agentDeckSessionId: "steward-x",
      profile: "smithy",
      worktreePath: "/wt/aaa",
      status: "torndown",
    });
    const gw = fakeGateway([], { listThrows: true });

    const result = await sweepLeakedStewards(store, gw);

    expect(result.reaped).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].profile).toBe("smithy");
    store.close();
  });

  it("reaps by tracked id when the leaked session reports no worktree", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "ad-keep-id",
      kind: "steward",
      agentDeckSessionId: "ad-keep-id",
      profile: "smithy",
      status: "torndown",
    });
    const gw = fakeGateway([session({ sessionId: "ad-keep-id" })]);

    const result = await sweepLeakedStewards(store, gw);

    expect(result.reaped.map((r) => r.sessionId)).toEqual(["ad-keep-id"]);
    store.close();
  });
});
