import { afterEach, describe, expect, it, vi } from "vitest";
import { broodListSessions, broodRegister, broodRetire, broodTeardown, type BroodSeam } from "./brood.js";
import { BroodNotFoundError } from "../../../brood/service/client.js";
import { buildTraceparent, spanIdForDispatch, traceIdForDispatch } from "../../../observability/trace-ids.js";

function seam(over: Partial<BroodSeam> = {}): BroodSeam {
  return {
    teardown: vi.fn(async (id: string) => ({ id, status: "removed", warnings: [] })),
    list: vi.fn(async () => []),
    register: vi.fn(async (input) => ({ ...input, status: input.status ?? "running", createdAt: "T", updatedAt: "T" }) as any),
    update: vi.fn(async (id, changes) => ({ id, kind: "steward", createdAt: "T", updatedAt: "T", ...changes }) as any),
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

  describe("traceparent propagation (#234)", () => {
    afterEach(() => vi.unstubAllGlobals());

    const okResponse = (): Response =>
      new Response(JSON.stringify({ id: "sess-1", status: "removed" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    it("derives a deterministic traceparent from traceKey and sends it on the default client", async () => {
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
      vi.stubGlobal("fetch", fetchMock);

      // No injected client → broodTeardown builds a traceparent-bearing BroodClient.
      const res = await broodTeardown("sess-1", { reason: "merged", traceKey: "slice-x" });
      expect(res.ok).toBe(true);

      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.traceparent).toBe(
        buildTraceparent(traceIdForDispatch("slice-x"), spanIdForDispatch("slice-x")),
      );
    });

    it("sends no traceparent when neither traceKey nor traceparent is given", async () => {
      const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => okResponse());
      vi.stubGlobal("fetch", fetchMock);

      await broodTeardown("sess-1", { reason: "merged" });
      const headers = (fetchMock.mock.calls[0]?.[1]?.headers ?? {}) as Record<string, string>;
      expect(headers.traceparent).toBeUndefined();
    });
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

  it("retire PATCHes the prior row to torndown without a worktree-pruning teardown (#308)", async () => {
    const update = vi.fn(async (id: string, changes: any) => ({ id, kind: "steward", createdAt: "T", updatedAt: "T", ...changes }) as any);
    const client = seam({ update });
    const res = await broodRetire("old-sess", client);
    expect(res).toMatchObject({ ok: true, notTracked: false });
    expect(update).toHaveBeenCalledWith("old-sess", expect.objectContaining({ status: "torndown" }));
    expect(update.mock.calls[0][1]).toHaveProperty("torndownAt");
  });

  it("retire flags a 404 as notTracked (nothing to retire — no phantom row)", async () => {
    const client = seam({
      update: vi.fn(async () => {
        throw new BroodNotFoundError('brood has no session "old-sess"');
      }),
    });
    const res = await broodRetire("old-sess", client);
    expect(res).toMatchObject({ ok: false, notTracked: true });
  });

  it("retire reports a generic failure as not-ok, not notTracked", async () => {
    const client = seam({
      update: vi.fn(async () => {
        throw new Error("brood down");
      }),
    });
    const res = await broodRetire("old-sess", client);
    expect(res).toMatchObject({ ok: false, notTracked: false });
  });
});
