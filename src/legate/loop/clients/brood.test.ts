import { describe, expect, it, vi } from "vitest";
import { broodListSessions, broodRegister, broodTeardown, type BroodSeam } from "./brood.js";
import { BroodNotFoundError } from "../../../brood/service/client.js";

function seam(over: Partial<BroodSeam> = {}): BroodSeam {
  return {
    teardown: vi.fn(async (id: string) => ({ id, status: "removed", warnings: [] })),
    list: vi.fn(async () => []),
    register: vi.fn(async (input) => ({ ...input, status: input.status ?? "running", createdAt: "T", updatedAt: "T" }) as any),
    ...over,
  };
}

describe("loop brood client (async BroodClient seam)", () => {
  it("teardown returns ok on a confirmed teardown and forwards flags", async () => {
    const client = seam({ teardown: vi.fn(async (id) => ({ id, status: "removed", warnings: ["worktree busy"] })) });
    const res = await broodTeardown("sess-1", { force: true, reason: "merged" }, client);
    expect(res).toEqual({ ok: true, notTracked: false, detail: "teardown sess-1: removed (warnings: worktree busy)" });
    expect(client.teardown).toHaveBeenCalledWith("sess-1", { force: true, kill: undefined, reason: "merged" });
  });

  it("teardown flags a 404 not-found as notTracked (defer, not success)", async () => {
    const client = seam({
      teardown: vi.fn(async () => {
        throw new BroodNotFoundError('brood has no session "sess-1"');
      }),
    });
    const res = await broodTeardown("sess-1", {}, client);
    expect(res.ok).toBe(false);
    expect(res.notTracked).toBe(true);
  });

  it("teardown reports a generic/transport failure as not-ok, not notTracked", async () => {
    const client = seam({
      teardown: vi.fn(async () => {
        throw new Error("Could not reach the brood service (502)");
      }),
    });
    const res = await broodTeardown("sess-1", {}, client);
    expect(res).toMatchObject({ ok: false, notTracked: false });
  });

  it("list forwards the filter and returns the records", async () => {
    const sessions = [{ id: "a", kind: "steward", status: "running" }] as any;
    const client = seam({ list: vi.fn(async () => sessions) });
    expect(await broodListSessions({ kind: "steward" }, client)).toEqual(sessions);
    expect(client.list).toHaveBeenCalledWith({ kind: "steward" });
  });

  it("list returns [] on failure", async () => {
    const client = seam({
      list: vi.fn(async () => {
        throw new Error("down");
      }),
    });
    expect(await broodListSessions({}, client)).toEqual([]);
  });

  it("register returns ok on a confirmed upsert and forwards the input", async () => {
    const client = seam();
    const input = { id: "sess-1", kind: "steward", worktreePath: "/wt", branch: "feature/x" } as const;
    const res = await broodRegister(input, client);
    expect(res.ok).toBe(true);
    expect(client.register).toHaveBeenCalledWith(input);
  });

  it("register returns not-ok on failure (caller defers rather than archiving over an orphan)", async () => {
    const client = seam({
      register: vi.fn(async () => {
        throw new Error("brood down");
      }),
    });
    const res = await broodRegister({ id: "sess-1", kind: "steward" }, client);
    expect(res).toMatchObject({ ok: false });
    expect(res.detail).toContain("brood down");
  });
});
