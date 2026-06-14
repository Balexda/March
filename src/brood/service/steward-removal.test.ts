/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import type { CastraSession } from "../../castra/types.js";
import { sqliteAvailable } from "./sqlite.js";
import { SessionStore } from "./store.js";
import {
  candidateHeadBranches,
  classifyOrphanWork,
  fetchBranchPrState,
  observeReconciliation,
  parseGitHubSlug,
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
    ...(over.metadata ? { metadata: over.metadata } : {}),
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
    branchPrState: async (branch) => opts.pr?.[branch] ?? "unknown",
  };
}

describe("classifyOrphanWork (age-gated dead-orphan criterion)", () => {
  const NOW = Date.parse("2026-06-13T00:00:00Z");
  const OLD = "2026-06-01T00:00:00Z"; // ~12 days before NOW
  const FRESH = "2026-06-12T23:00:00Z"; // 1 hour before NOW
  const ON = { deadOrphanAgeMs: 24 * 3_600_000, now: NOW };

  it("leaves no-branch / no-pr orphans `unknown` when the criterion is OFF (default)", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "a", status: "waiting", createdAt: OLD }),
        "/repo",
        fakeGate(),
      ),
    ).toEqual({ state: "unknown", reason: "no-branch" });
    expect(
      await classifyOrphanWork(
        session({ sessionId: "b", status: "waiting", createdAt: OLD, branch: "feature/x" }),
        "/repo",
        fakeGate({ pr: { "feature/x": "none" } }),
      ),
    ).toEqual({ state: "unknown", reason: "no-pr" });
  });

  it("reaps an old, non-running no-branch orphan as dead-orphan when armed", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "a", status: "waiting", createdAt: OLD }),
        "/repo",
        fakeGate(),
        ON,
      ),
    ).toEqual({ state: "done", reason: "dead-orphan" });
  });

  it("reaps an old, non-running no-pr orphan as dead-orphan when armed", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "b", status: "stopped", createdAt: OLD, branch: "feature/x" }),
        "/repo",
        fakeGate({ pr: { "feature/x": "none" } }),
        ON,
      ),
    ).toEqual({ state: "done", reason: "dead-orphan" });
  });

  it("never reaps a RUNNING orphan even when old", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "c", status: "running", createdAt: OLD }),
        "/repo",
        fakeGate(),
        ON,
      ),
    ).toEqual({ state: "unknown", reason: "no-branch" });
  });

  it("never reaps a too-young orphan", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "d", status: "waiting", createdAt: FRESH }),
        "/repo",
        fakeGate(),
        ON,
      ),
    ).toEqual({ state: "unknown", reason: "no-branch" });
  });

  it("keeps the OPEN-PR protection for an old, non-running orphan", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "e", status: "waiting", createdAt: OLD, branch: "feature/o" }),
        "/repo",
        fakeGate({ pr: { "feature/o": "open" } }),
        ON,
      ),
    ).toEqual({ state: "in-progress", reason: "open-pr" });
  });

  it("never reaps on an indeterminate PR lookup (could hide an open PR)", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "f", status: "waiting", createdAt: OLD, branch: "feature/q" }),
        "/repo",
        fakeGate({ pr: { "feature/q": "unknown" } }),
        ON,
      ),
    ).toEqual({ state: "unknown", reason: "pr-lookup-unknown" });
  });

  it("a merged PR is done regardless of age/status", async () => {
    expect(
      await classifyOrphanWork(
        session({ sessionId: "g", status: "running", createdAt: FRESH, branch: "feature/m" }),
        "/repo",
        fakeGate({ pr: { "feature/m": "merged" } }),
        ON,
      ),
    ).toEqual({ state: "done", reason: "pr-merged" });
  });
});

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

  it("adopts an untracked open-PR steward into Brood when adopt is on (#304/#308 source fix)", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    // Only a torndown row exists → the live open-PR session is an untracked orphan.
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
      session({
        sessionId: "live",
        worktreePath: "/wt/new",
        branch: "feature/open",
        group: "march",
        metadata: { spawnId: "spawn-9" },
      }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/open": "open" } }),
      { adopt: true },
    );

    expect(result.adopted.map((a) => a.sessionId)).toEqual(["live"]);
    expect(result.reaped).toEqual([]);
    expect(gw.removed).toEqual([]); // a live open-PR steward is never removed
    // It is now a tracked-live steward row (legate will manage/merge it), with
    // the spawn id threaded through as parentId (#308) and its workspace.
    expect(store.get("live")).toMatchObject({
      kind: "steward",
      status: "running",
      parentId: "spawn-9",
      branch: "feature/open",
      worktreePath: "/wt/new",
      agentDeckSessionId: "live",
      repoPath: "/repo",
      group: "march",
    });
    store.close();
  });

  it("skips (does not adopt) an open-PR steward when adopt is off — the conservative default", async () => {
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
      session({ sessionId: "live", worktreePath: "/wt/new", branch: "feature/open" }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/open": "open" } }),
    );

    expect(result.adopted).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("open-pr");
    expect(store.get("live")).toBeUndefined();
    store.close();
  });

  it("reaps an old, non-running no-pr dead orphan when the criterion is armed", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/d",
      status: "torndown",
    });
    const gw = fakeGateway([
      session({
        sessionId: "dead",
        worktreePath: "/wt/dead",
        branch: "feature/d",
        status: "waiting",
        createdAt: "2026-06-01T00:00:00Z",
      }),
    ]);

    const result = await sweepLeakedStewards(
      store,
      gw,
      fakeGate({ pr: { "feature/d": "none" } }),
      { deadOrphanAgeMs: 24 * 3_600_000, now: Date.parse("2026-06-13T00:00:00Z") },
    );

    expect(result.reaped.map((r) => r.reason)).toEqual(["dead-orphan"]);
    expect(gw.removed).toEqual(["dead"]);
    store.close();
  });

  it("with reaping disabled (adopt-only pass), leaves a confirmed-done orphan in place", async () => {
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
      { reap: false, adopt: true },
    );

    expect(result.reaped).toEqual([]);
    expect(gw.removed).toEqual([]);
    expect(result.skipped.map((s) => s.reason)).toContain("worktree-gone");
    store.close();
  });
});

describe.skipIf(!sqliteAvailable)("observeReconciliation", () => {
  it("counts a live session an active Brood record owns as tracked, not orphan", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "live-1",
      kind: "steward",
      agentDeckSessionId: "live-1",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/a",
      branch: "feature/a",
      status: "running",
    });
    const gw = fakeGateway([session({ sessionId: "live-1", worktreePath: "/wt/a", branch: "feature/a" })]);

    const obs = await observeReconciliation(store, gw);

    expect(obs).toEqual([{ profile: "smithy", castraLive: 1, trackedActive: 1, orphans: 0 }]);
    store.close();
  });

  it("counts live Castra sessions with only torndown Brood rows as orphans (the wedge)", async () => {
    // The live-stack shape: every Brood steward row is torndown, yet Castra still
    // lists the sessions → all orphans (the "54 live, 0 tracked" divergence).
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "old-1",
      kind: "steward",
      agentDeckSessionId: "old-1",
      profile: "march",
      repoPath: "/repo",
      worktreePath: "/wt/old",
      branch: "feature/old",
      status: "torndown",
    });
    const gw = fakeGateway([
      session({ sessionId: "ghost-1", worktreePath: "/wt/g1" }),
      session({ sessionId: "ghost-2", worktreePath: "/wt/g2" }),
    ]);

    const obs = await observeReconciliation(store, gw);

    expect(obs).toEqual([{ profile: "march", castraLive: 2, trackedActive: 0, orphans: 2 }]);
    // Read-only: no removals.
    expect(gw.removed).toEqual([]);
    store.close();
  });

  it("skips a profile whose Castra list fails rather than emitting a misleading zero", async () => {
    const store = new SessionStore({ dbPath: ":memory:" });
    store.register({
      id: "s",
      kind: "steward",
      profile: "smithy",
      repoPath: "/repo",
      worktreePath: "/wt/a",
      status: "running",
    });
    const gw = fakeGateway([], { listThrows: true });

    const obs = await observeReconciliation(store, gw);

    expect(obs).toEqual([]);
    store.close();
  });
});

describe("parseGitHubSlug", () => {
  it("parses the scp-short, https, and ssh remote forms", () => {
    expect(parseGitHubSlug("git@github.com:Balexda/March.git")).toEqual({
      owner: "Balexda",
      repo: "March",
    });
    expect(parseGitHubSlug("https://github.com/Balexda/March")).toEqual({
      owner: "Balexda",
      repo: "March",
    });
    expect(parseGitHubSlug("ssh://git@github.com/Balexda/March.git")).toEqual({
      owner: "Balexda",
      repo: "March",
    });
  });

  it("returns undefined for a non-GitHub remote", () => {
    expect(parseGitHubSlug("git@gitlab.com:acme/widget.git")).toBeUndefined();
  });
});

describe("fetchBranchPrState (token REST path, no gh)", () => {
  // A fake `fetch` over a fixed PR list — proves the gate resolves PR state via
  // the GitHub REST API with a token and never shells out to `gh`.
  function fetchReturning(
    prs: Array<{ state: string; merged_at: string | null }>,
    status = 200,
  ): { impl: typeof fetch; calls: Array<{ url: string; init?: RequestInit }> } {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const impl = (async (url: string | URL, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      return new Response(JSON.stringify(prs), { status });
    }) as unknown as typeof fetch;
    return { impl, calls };
  }

  it("reports merged when a PR for the head branch is merged", async () => {
    const { impl, calls } = fetchReturning([
      { state: "closed", merged_at: "2026-06-01T00:00:00Z" },
    ]);
    const state = await fetchBranchPrState({
      owner: "Balexda",
      repo: "March",
      branch: "feature/screens",
      token: "t0ken",
      fetchImpl: impl,
    });
    expect(state).toBe("merged");
    // head=owner:branch and the bearer token are on the request.
    expect(calls[0].url).toContain("head=Balexda%3Afeature%2Fscreens");
    expect(
      (calls[0].init?.headers as Record<string, string>).authorization,
    ).toBe("Bearer t0ken");
  });

  it("reports open / closed / none from the PR list", async () => {
    const open = fetchReturning([{ state: "open", merged_at: null }]);
    expect(
      await fetchBranchPrState({ owner: "o", repo: "r", branch: "b", token: "t", fetchImpl: open.impl }),
    ).toBe("open");

    const closed = fetchReturning([{ state: "closed", merged_at: null }]);
    expect(
      await fetchBranchPrState({ owner: "o", repo: "r", branch: "b", token: "t", fetchImpl: closed.impl }),
    ).toBe("closed");

    const none = fetchReturning([]);
    expect(
      await fetchBranchPrState({ owner: "o", repo: "r", branch: "b", token: "t", fetchImpl: none.impl }),
    ).toBe("none");
  });

  it("reports unknown on a non-2xx response (never a false done)", async () => {
    const { impl } = fetchReturning([], 403);
    expect(
      await fetchBranchPrState({ owner: "o", repo: "r", branch: "b", token: "t", fetchImpl: impl }),
    ).toBe("unknown");
  });

  it("reports unknown when the transport throws", async () => {
    const impl = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    expect(
      await fetchBranchPrState({ owner: "o", repo: "r", branch: "b", token: "t", fetchImpl: impl }),
    ).toBe("unknown");
  });

  // The deciding live-stack mismatch: the steward carries the LOCAL branch
  // `smithy/cut/X`, but the worker pushed it as PR head `feature/smithy/cut/X`.
  // A query by the raw local name finds nothing — the `feature/` variant wins.
  it("resolves a merged PR pushed under a feature/ prefix (#304 prefix mismatch)", async () => {
    const impl = (async (url: string | URL) => {
      const u = String(url);
      // Only the feature/-prefixed head has the merged PR; the raw name has none.
      if (u.includes(encodeURIComponent("o:feature/smithy/cut/X"))) {
        return new Response(
          JSON.stringify([{ state: "closed", merged_at: "2026-06-06T00:00:00Z" }]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const state = await fetchBranchPrState({
      owner: "o",
      repo: "r",
      branch: "smithy/cut/X",
      token: "t",
      fetchImpl: impl,
    });
    expect(state).toBe("merged");
  });

  it("keeps an OPEN feature/-prefixed PR as open (never reaped)", async () => {
    const impl = (async (url: string | URL) => {
      const u = String(url);
      if (u.includes(encodeURIComponent("o:feature/smithy/cut/Y"))) {
        return new Response(
          JSON.stringify([{ state: "open", merged_at: null }]),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }) as unknown as typeof fetch;

    const state = await fetchBranchPrState({
      owner: "o",
      repo: "r",
      branch: "smithy/cut/Y",
      token: "t",
      fetchImpl: impl,
    });
    expect(state).toBe("open");
  });
});

describe("candidateHeadBranches", () => {
  it("adds the feature/-prefixed variant for a bare worker branch", () => {
    expect(candidateHeadBranches("smithy/cut/X")).toEqual([
      "smithy/cut/X",
      "feature/smithy/cut/X",
    ]);
  });

  it("adds the feature/-stripped variant for an already-prefixed branch", () => {
    expect(candidateHeadBranches("feature/smithy/cut/X")).toEqual([
      "feature/smithy/cut/X",
      "smithy/cut/X",
    ]);
  });
});
