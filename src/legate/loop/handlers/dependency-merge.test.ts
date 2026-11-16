/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  apply,
  CHECK_INTERVAL_MS,
  dependencyChecks,
  dependencyPrVerdict,
  isDependencyFile,
  type DependencyPr,
} from "./dependency-merge.js";

const ok = (over: Partial<DependencyPr> = {}): DependencyPr => ({
  number: 7,
  title: "bump vite",
  author: { login: "app/dependabot", is_bot: true },
  isDraft: false,
  headRefOid: "abc123",
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
  files: [{ path: "package.json" }, { path: "package-lock.json" }],
  ...over,
});

describe("isDependencyFile", () => {
  it("accepts manifests, lockfiles and workflow files at any depth", () => {
    for (const p of ["package.json", "apps/web/package-lock.json", "go.sum", ".github/workflows/ci.yml", "docker/hatchery.Dockerfile"]) {
      expect(isDependencyFile(p)).toBe(true);
    }
  });
  it("rejects source, docs and other .github files", () => {
    for (const p of ["src/cli.ts", "README.md", ".github/copilot-instructions.md", ".github/workflows/scripts/run.sh", "package.json.bak"]) {
      expect(isDependencyFile(p)).toBe(false);
    }
  });
});

describe("dependencyChecks", () => {
  it("NONE without checks, PASS when all succeeded/skipped", () => {
    expect(dependencyChecks([])).toBe("NONE");
    expect(dependencyChecks(undefined)).toBe("NONE");
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }, { state: "SUCCESS" }])).toBe("PASS");
  });
  it("FAIL on any failed/cancelled check, PENDING while one is running", () => {
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }, { status: "COMPLETED", conclusion: "CANCELLED" }])).toBe("FAIL");
    expect(dependencyChecks([{ status: "COMPLETED", conclusion: "FAILURE" }, { status: "IN_PROGRESS", conclusion: "" }])).toBe("FAIL");
    expect(dependencyChecks([{ status: "IN_PROGRESS", conclusion: "" }])).toBe("PENDING");
    expect(dependencyChecks([{ state: "PENDING" }])).toBe("PENDING");
  });
});

describe("dependencyPrVerdict", () => {
  it("accepts a green, clean Dependabot version bump", () => {
    expect(dependencyPrVerdict(ok())).toEqual({ eligible: true });
  });
  it.each([
    ["a human author", { author: { login: "alice" } }, "not opened by Dependabot"],
    ["a draft", { isDraft: true }, "draft"],
    ["a source file in the diff", { files: [{ path: "package.json" }, { path: "src/index.ts" }] }, "non-dependency file"],
    ["an unknown file list", { files: [] }, "changed files unknown"],
    ["no CI at all", { statusCheckRollup: [] }, "checks NONE"],
    ["failing CI", { statusCheckRollup: [{ status: "COMPLETED", conclusion: "FAILURE" }] }, "checks FAIL"],
    ["running CI", { statusCheckRollup: [{ status: "QUEUED" }] }, "checks PENDING"],
    ["a conflict", { mergeable: "CONFLICTING" }, "mergeable CONFLICTING"],
    ["a non-clean merge state", { mergeStateStatus: "BEHIND" }, "merge state BEHIND"],
    ["a missing head SHA", { headRefOid: undefined }, "head SHA unknown"],
  ])("rejects %s", (_name, over, reason) => {
    const verdict = dependencyPrVerdict(ok(over as Partial<DependencyPr>));
    expect(verdict.eligible).toBe(false);
    expect((verdict as { reason: string }).reason).toContain(reason);
  });
});

describe("apply", () => {
  const ctx = {} as any;
  const state = (autoMerge: boolean | undefined, raw: any = {}): any => ({
    repoPath: "/repo",
    raw,
    mergePolicy: autoMerge === undefined ? undefined : { dependencyUpdates: { autoMerge } },
  });
  const deps = (prs: DependencyPr[], merged = true, now = 1_000_000) => ({
    listDependencyPrs: vi.fn(async () => prs),
    mergePr: vi.fn(async () => (merged ? { merged: true } : { merged: false, error: "boom" })),
    now: () => now,
  });

  it("is inert unless the profile opts in (no GitHub call)", async () => {
    for (const s of [state(undefined), state(false)]) {
      const d = deps([ok()]);
      const res = await apply(ctx, s, d);
      expect(res.actions).toEqual([]);
      expect(d.listDependencyPrs).not.toHaveBeenCalled();
    }
  });

  it("merges the oldest eligible PR, pinned to its head SHA, and only one per check", async () => {
    const d = deps([ok({ number: 9, headRefOid: "s9" }), ok({ number: 5, headRefOid: "s5" }), ok({ number: 3, isDraft: true })]);
    const res = await apply(ctx, state(true), d);
    expect(d.mergePr).toHaveBeenCalledTimes(1);
    expect(d.mergePr).toHaveBeenCalledWith({ prNumber: 5, headSha: "s5", repoPath: "/repo" });
    expect(res.actions.map((a) => a.action)).toEqual(["dependency-auto-merge"]);
  });

  it("throttles GitHub queries to one per interval", async () => {
    const s = state(true);
    const first = deps([], true, 1_000_000);
    await apply(ctx, s, first);
    const soon = deps([ok()], true, 1_000_000 + CHECK_INTERVAL_MS - 1);
    await apply(ctx, s, soon);
    expect(soon.listDependencyPrs).not.toHaveBeenCalled();
    const later = deps([ok()], true, 1_000_000 + CHECK_INTERVAL_MS);
    await apply(ctx, s, later);
    expect(later.mergePr).toHaveBeenCalledTimes(1);
  });

  it("records a failed merge and does not retry the same head; a new head retries", async () => {
    const s = state(true);
    const fail = deps([ok()], false, 1_000_000);
    const res = await apply(ctx, s, fail);
    expect(res.failures.map((f) => f.action)).toEqual(["dependency-auto-merge-failed"]);
    const same = deps([ok()], true, 2_000_000);
    await apply(ctx, s, same);
    expect(same.mergePr).not.toHaveBeenCalled();
    const pushed = deps([ok({ headRefOid: "new" })], true, 3_000_000);
    await apply(ctx, s, pushed);
    expect(pushed.mergePr).toHaveBeenCalledTimes(1);
  });

  it("reports a listing failure without throwing", async () => {
    const d = deps([]);
    d.listDependencyPrs.mockRejectedValueOnce(new Error("gh down"));
    const res = await apply(ctx, state(true), d);
    expect(res.failures).toEqual([{ action: "dependency-merge-list-failed", detail: "gh down" }]);
  });
});
