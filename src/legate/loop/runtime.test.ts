import { afterEach, describe, expect, it, vi } from "vitest";

// Focused coverage for the async/await fixes in issue #178 bugs 2 & 3, both in
// runtime.ts (the @ts-nocheck lifted loop):
//   - agentDeckSessionHoldsWorktree must await senseIo().listSessions() so the
//     "a live session holds this worktree — don't remove it" guard actually
//     fires (before the fix Array.isArray(Promise) was always false → the guard
//     always returned false → unsafe cleanup was never blocked).
//   - tryAdoptOpenPr must await senseIo().prMatchesSliceBranch so it adopts the
//     PR on the matching branch rather than blindly the first candidate.
//
// runtime.ts builds its CastraClient + senseIo lazily from module globals and
// reaches git/gh via node:child_process. We mock child_process and inject a
// fake senseIo through the __test seam so these now-active paths run without a
// live Castra or repo.
const childProcessMock = { execFile: vi.fn(), spawn: vi.fn() };
vi.mock("node:child_process", () => ({
  execFile: childProcessMock.execFile,
  spawn: childProcessMock.spawn,
}));

const { __test } = await import("./runtime.js");

/** Route execFile(cmd,args,…) to canned stdout (mirrors sense-io.test). */
function routeExec(router: (cmd: string, args: string[]) => string): void {
  childProcessMock.execFile.mockImplementation(
    (cmd: string, args: string[], opts: unknown, cb?: unknown) => {
      const callback = (typeof opts === "function" ? opts : cb) as (
        e: unknown,
        out: string,
        err: string,
      ) => void;
      try {
        callback(null, router(cmd, args), "");
      } catch (err) {
        callback(err, "", String((err as Error).message));
      }
    },
  );
}

function fakeSenseIo(over: Record<string, unknown> = {}): any {
  return {
    listSessions: async () => [],
    prMatchesSliceBranch: async () => false,
    queryPrForBabysit: async () => ({ skipped: true }),
    ...over,
  };
}

afterEach(() => {
  childProcessMock.execFile.mockReset();
  __test.setSenseIo(undefined);
});

describe("agentDeckSessionHoldsWorktree (issue #178 bug 2)", () => {
  it("blocks removal when a live session holds the worktree", async () => {
    __test.setSenseIo(
      fakeSenseIo({
        listSessions: async () => [
          { id: "s1", worktree_path: "/wt/held" },
          { id: "s2", worktree_path: "/wt/other" },
        ],
      }),
    );
    // Before the fix this awaited nothing → Array.isArray(Promise) === false →
    // always false, so a held worktree was never recognized.
    expect(await __test.agentDeckSessionHoldsWorktree("/wt/held")).toBe(true);
  });

  it("returns false when no session points at the worktree", async () => {
    __test.setSenseIo(
      fakeSenseIo({ listSessions: async () => [{ id: "s1", worktree_path: "/wt/other" }] }),
    );
    expect(await __test.agentDeckSessionHoldsWorktree("/wt/held")).toBe(false);
  });

  it("recognizes the worktree under any field-name variant", async () => {
    for (const session of [
      { worktree_path: "/wt/held" },
      { path: "/wt/held" },
      { worktreePath: "/wt/held" },
    ]) {
      __test.setSenseIo(fakeSenseIo({ listSessions: async () => [session] }));
      expect(await __test.agentDeckSessionHoldsWorktree("/wt/held")).toBe(true);
    }
  });

  it("returns false when listSessions reports an error (not an array)", async () => {
    __test.setSenseIo(fakeSenseIo({ listSessions: async () => ({ error: "castra down" }) }));
    expect(await __test.agentDeckSessionHoldsWorktree("/wt/held")).toBe(false);
  });
});

describe("tryAdoptOpenPr (issue #178 bug 3)", () => {
  // inspectCollidedBranch reads the colliding branch via git/gh; route those so
  // classifyBranchCollision yields an "open-pr" verdict with two open PRs whose
  // branches we control.
  function routeCollision(openPrs: Array<Record<string, unknown>>): void {
    routeExec((cmd, args) => {
      if (cmd === "git" && args.includes("rev-parse")) return "deadbeef\n";
      if (cmd === "git" && args.includes("merge-base")) return ""; // ancestor check
      if (cmd === "gh" && args.includes("list")) return JSON.stringify(openPrs);
      return "";
    });
  }

  it("adopts the PR on the matching branch, not merely the first candidate", async () => {
    __test.setMeta({ repo: { path: "/repo", default_branch: "main" } });
    routeCollision([
      { number: 1, state: "OPEN", head_branch: "feature/wrong" },
      { number: 2, state: "OPEN", head_branch: "feature/right" },
    ]);

    const queried: number[] = [];
    __test.setSenseIo(
      fakeSenseIo({
        // Only the second candidate is on our branch. With the old un-awaited
        // Array.find this returned a Promise for #1 (truthy) → #1 adopted.
        prMatchesSliceBranch: async (_slice: any, pr: any) => pr.head_branch === "feature/right",
        queryPrForBabysit: async (slice: any) => {
          queried.push(slice.pr.number);
          return { number: slice.pr.number, url: "https://github.com/o/r/pull/" + slice.pr.number };
        },
      }),
    );

    const slice: any = { branch: "feature/right" };
    const result = await __test.tryAdoptOpenPr(
      { repo: { path: "/repo", default_branch: "main" } },
      slice,
      "slice-1",
      "fatal: a branch named 'feature/right' already exists",
      "2026-05-20T00:00:00Z",
    );

    expect(result).toMatchObject({ recovered: true, verdict: "open-pr-adopted" });
    expect(result.detail).toContain("PR #2");
    expect(queried).toEqual([2]); // hydrated the matching PR, never the wrong one
    expect(slice.stage).toBe("pr-open");
    expect(slice.last_action_note).toContain("#2");
  });
});
