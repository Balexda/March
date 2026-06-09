import { describe, expect, it } from "vitest";
import type { CastraSession } from "../../castra/types.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import {
  removeStewardViaCastra,
  sweepLeakedStewards,
  type BranchPrState,
  type CastraStewardGateway,
  type OrphanGate,
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

/** Fake orphan gate: declared PR states per branch + a set of missing worktrees. */
function fakeGate(
  opts: { pr?: Record<string, BranchPrState>; missingWorktrees?: string[] } = {},
): OrphanGate {
  const missing = new Set(opts.missingWorktrees ?? []);
  return {
    worktreeExists: (p) => !missing.has(p),
    branchPrState: (branch) => opts.pr?.[branch] ?? "unknown",
  };
}

describe.skipIf(!sqliteAvailable)("sweepLeakedStewards", () => {
  it("reaps a true orphan whose branch maps to a MERGED pr (#304)", async () => {
    // The exact live-stack shape: Brood only has the FIRST attempt (torndown,
    // worktree hash d4143794). The relaunch made a NEW orphan with a NEW id AND
    // a NEW worktree hash (898689c7) that Brood never tracked — so keying off the
    // torndown row's worktree can't find it. The merged PR is what proves it done.
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "e4473b5d",
      kind: "steward",
      agentDeckSessionId: "e4473b5d",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/screens-d4143794",
      branch: "feature/screens",
      status: "torndown",
    });
    const gw = fakeGateway([
      session({
        sessionId: "ab825c26",
        worktreePath: "/wt/screens-898689c7",
        branch: "feature/screens",
      }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/screens": "merged" } }),
    );

    expect(result.reaped.map((r) => r.sessionId)).toEqual(["ab825c26"]);
    expect(result.reaped[0].reason).toBe("pr-merged");
    expect(gw.removed).toEqual(["ab825c26"]);
    store.close();
  });

  it("never reaps a live steward whose branch has an OPEN pr", async () => {
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
    const gw = fakeGateway([
      session({ sessionId: "live", worktreePath: "/wt/new", branch: "feature/x" }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/x": "open" } }),
    );

    expect(result.reaped).toEqual([]);
    expect(gw.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("open-pr");
    store.close();
  });

  it("reaps an orphan whose worktree no longer exists on disk", async () => {
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
    const gw = fakeGateway([
      session({ sessionId: "leaked", worktreePath: "/wt/gone", branch: "feature/y" }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ missingWorktrees: ["/wt/gone"] }),
    );

    expect(result.reaped.map((r) => r.sessionId)).toEqual(["leaked"]);
    expect(result.reaped[0].reason).toBe("worktree-gone");
    store.close();
  });

  it("never reaps a session an active Brood record still tracks", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "live-steward",
      kind: "steward",
      agentDeckSessionId: "live-steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/live",
      branch: "feature/z",
      status: "running",
    });
    // Even if the gate would call it done, a tracked-live session is teardown's job.
    const gw = fakeGateway([
      session({ sessionId: "live-steward", worktreePath: "/wt/live", branch: "feature/z" }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/z": "merged" } }),
    );

    expect(result.reaped).toEqual([]);
    expect(gw.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("tracked");
    store.close();
  });

  it("leaves an orphan in place when its PR state cannot be determined", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/q",
      status: "torndown",
    });
    const gw = fakeGateway([
      session({ sessionId: "maybe", worktreePath: "/wt/maybe", branch: "feature/q" }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/q": "unknown" } }),
    );

    expect(result.reaped).toEqual([]);
    expect(gw.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("pr-lookup-unknown");
    store.close();
  });

  it("records a per-profile failure when Castra is unreachable and keeps going", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "steward-x",
      kind: "steward",
      agentDeckSessionId: "steward-x",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/aaa",
      status: "torndown",
    });
    const gw = fakeGateway([], { listThrows: true });

    const result = await sweepLeakedStewards(store, gw, fakeGate());

    expect(result.reaped).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0].profile).toBe("smithy");
    store.close();
  });
});
