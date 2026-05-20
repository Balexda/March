import { describe, expect, it, vi } from "vitest";
import { broodListSessions, broodTeardown, type CliResult } from "./brood.js";

const ok = (stdout = ""): CliResult => ({ status: 0, stdout, stderr: "" });
const fail = (stderr: string, status = 1): CliResult => ({ status, stdout: "", stderr });

describe("loop brood client (march brood CLI)", () => {
  it("teardown returns ok on exit 0 and passes flags", () => {
    const run = vi.fn(() => ok("worktree: ok\n"));
    const res = broodTeardown("sess-1", { force: true, reason: "merged" }, run);
    expect(res).toEqual({ ok: true, notTracked: false, detail: "worktree: ok" });
    expect(run).toHaveBeenCalledWith(["brood", "teardown", "sess-1", "--force", "--reason", "merged"]);
  });

  it("teardown flags a 404 'not tracked' as notTracked (defer, not success)", () => {
    const run = vi.fn(() => fail('Session "sess-1" is not tracked by Brood; cannot confirm teardown.'));
    const res = broodTeardown("sess-1", {}, run);
    expect(res.ok).toBe(false);
    expect(res.notTracked).toBe(true);
  });

  it("teardown reports a generic failure as not-ok, not notTracked", () => {
    const res = broodTeardown("sess-1", {}, () => fail("brood teardown failed (502)"));
    expect(res).toMatchObject({ ok: false, notTracked: false });
  });

  it("list parses --json output", () => {
    const sessions = [{ id: "a", kind: "steward", status: "running" }];
    const run = vi.fn(() => ok(JSON.stringify(sessions)));
    expect(broodListSessions({ kind: "steward" }, run)).toEqual(sessions);
    expect(run).toHaveBeenCalledWith(["brood", "list", "--json", "--kind", "steward"]);
  });

  it("list returns [] on failure or unparseable output", () => {
    expect(broodListSessions({}, () => fail("down"))).toEqual([]);
    expect(broodListSessions({}, () => ok("not json"))).toEqual([]);
  });
});
