/**
 * @l0 @deterministic @ci
 */
import { describe, it, expect, vi } from "vitest";

import {
  CastraClient,
  CastraClientError,
  resolveCastraBaseUrl,
  resolveCastraToken,
} from "./client.js";
import { castraPort } from "./config.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("castra client — config resolution", () => {
  it("prefers CASTRA_URL and strips trailing slashes", () => {
    expect(resolveCastraBaseUrl({ CASTRA_URL: "http://castra:9264/" })).toBe(
      "http://castra:9264",
    );
  });

  it("falls back to localhost on the deterministic port", () => {
    expect(resolveCastraBaseUrl({})).toBe(`http://localhost:${castraPort()}`);
  });

  it("reads the bearer token, treating blank as unset", () => {
    expect(resolveCastraToken({ CASTRA_API_TOKEN: "secret" })).toBe("secret");
    expect(resolveCastraToken({ CASTRA_API_TOKEN: "  " })).toBeUndefined();
    expect(resolveCastraToken({})).toBeUndefined();
  });
});

describe("castra client — requests", () => {
  it("validates live inventory and keeps malformed and failed responses distinct from empty", async () => {
    const fetchImpl = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(jsonResponse(200, { names: [] }))
      .mockResolvedValueOnce(jsonResponse(200, { names: [null] }))
      .mockResolvedValueOnce(jsonResponse(401, {
        error: { code: "unauthorized", message: "Missing or invalid bearer token." },
      }));
    const client = new CastraClient({ baseUrl: "http://castra:9264", token: "secret", fetchImpl });

    await expect(client.listInteractiveSessions()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledWith("http://castra:9264/v1/interactive-sessions",
      expect.objectContaining({
        method: "GET",
        headers: { authorization: "Bearer secret" },
        signal: expect.any(AbortSignal),
      }),
    );
    await expect(client.listInteractiveSessions()).rejects.toThrow("valid interactive session inventory");
    await expect(client.listInteractiveSessions()).rejects.toMatchObject({ status: 401, code: "unauthorized" });
  });

  it("launches a session with the bearer token and trace header", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, {
        session: {
          sessionId: "s1",
          title: "Steward",
          group: "g",
          branch: "march/spawn/x",
          worktreePath: "/repo/feature-march-spawn-x",
          createdAt: "2026-05-20T00:00:00Z",
        },
      }),
    );
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    const session = await client.launchSession({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      group: "g",
      model: "opus",
      traceKey: "slice-1",
    });

    expect(session.worktreePath).toBe("/repo/feature-march-spawn-x");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://castra:9264/v1/sessions");
    expect(init.method).toBe("POST");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer secret");
    expect(headers["x-march-slice-id"]).toBe("slice-1");
    expect(JSON.parse(init.body as string)).toMatchObject({
      profile: "march",
      branch: "march/spawn/x",
      model: "opus",
    });
  });

  it("forwards session metadata in the launch body (#214)", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(201, {
        session: {
          sessionId: "s1",
          title: "Steward",
          group: "g",
          branch: "march/spawn/x",
          worktreePath: "/wt/x",
          createdAt: "2026-05-20T00:00:00Z",
          metadata: { sliceId: "slice-1", spawnId: "sp-1" },
        },
      }),
    );
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const session = await client.launchSession({
      profile: "march",
      repoPath: "/repo",
      branch: "march/spawn/x",
      title: "Steward",
      metadata: { sliceId: "slice-1", spawnId: "sp-1" },
    });
    expect(session.metadata).toEqual({ sliceId: "slice-1", spawnId: "sp-1" });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toMatchObject({
      metadata: { sliceId: "slice-1", spawnId: "sp-1" },
    });
  });

  it("sends createBranch:false for an attach launch, and omits it otherwise", async () => {
    const session = {
      sessionId: "s2",
      title: "t",
      group: "g",
      branch: "b",
      worktreePath: "/w",
      createdAt: "c",
    };
    const fetchImpl = vi.fn(async () => jsonResponse(201, { session }));
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    // Attach: createBranch:false MUST reach the server (else it defaults to a
    // `-b` create and collides with the existing relaunch branch).
    await client.launchSession({ profile: "smithy", repoPath: "/r", branch: "b", title: "t", createBranch: false });
    const [, attachInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(attachInit.body as string)).toMatchObject({ createBranch: false });

    // Default (create): the field is omitted so the server applies its `-b` default.
    await client.launchSession({ profile: "smithy", repoPath: "/r", branch: "b", title: "t" });
    const [, createInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(JSON.parse(createInit.body as string)).not.toHaveProperty("createBranch");
  });

  it("aborts in-flight list and remove requests on the caller's deadline signal", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), { once: true });
    }));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    const reason = new Error("teardown deadline exceeded");
    const listing = new AbortController();
    const removal = new AbortController();

    const list = client.listSessions("march", undefined, listing.signal);
    const remove = client.removeSession({ profile: "march", sessionId: "s1", pruneWorktree: false, signal: removal.signal });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));
    listing.abort(reason);
    removal.abort(reason);

    await expect(list).rejects.toBe(reason);
    await expect(remove).rejects.toBe(reason);
  });

  it("lists sessions via GET with the profile + group query", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sessions: [{ sessionId: "s1", group: "g" }] }));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    const sessions = await client.listSessions("march", "g");
    expect(sessions).toHaveLength(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://castra:9264/v1/sessions?profile=march&group=g");
    expect(init.method).toBe("GET");
  });

  it("reads recent session output via GET", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { output: "recent log" }));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    const output = await client.sessionOutput("march", "s1");
    expect(output).toBe("recent log");
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("http://castra:9264/v1/sessions/s1/output?profile=march");
  });

  it("maps a non-2xx envelope to a typed error preserving code + status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(409, { error: { code: "conflict", message: "launch race" } }),
    );
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(
      client.launchSession({
        profile: "march",
        repoPath: "/repo",
        branch: "b",
        title: "t",
      }),
    ).rejects.toMatchObject({
      name: "CastraClientError",
      code: "conflict",
      status: 409,
      message: "launch race",
    });
  });

  it("wraps transport failures as CastraClientError", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await expect(
      client.sendPrompt({ profile: "p", sessionId: "s", prompt: "hi" }),
    ).rejects.toBeInstanceOf(CastraClientError);
  });

  it("sends prompts expecting a 202", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(202, { ok: true }));
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.sendPrompt({ profile: "p", sessionId: "s 1", prompt: "go" });
    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    // session id is percent-encoded into the path.
    expect(url).toBe("http://castra:9264/v1/sessions/s%201/send");
  });

  it("removes a session, encoding pruneWorktree as a query param", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { ok: true, removed: true }));
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const result = await client.removeSession({
      profile: "p",
      sessionId: "s",
      pruneWorktree: true,
    });
    expect(result).toEqual({ removed: true });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe("DELETE");
    expect(url).toContain("profile=p");
    expect(url).toContain("pruneWorktree=true");
  });

  it("posts a recovery sweep and returns the report", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, {
        recovered: [
          {
            sessionId: "w1",
            title: "forge",
            group: "legate-workers",
            outcome: "picker_resolved",
            pickerResolved: true,
            finalStatus: "waiting",
          },
        ],
      }),
    );
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const report = await client.recoverSessions("march", "legate-workers");
    expect(report.recovered[0]).toMatchObject({ sessionId: "w1", outcome: "picker_resolved" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://castra:9264/v1/sessions/recover");
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toEqual({ profile: "march", group: "legate-workers" });
  });

  it("omits the group from the recovery body when not given", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { recovered: [] }));
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const report = await client.recoverSessions("march");
    expect(report).toEqual({ recovered: [] });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ profile: "march" });
  });

  it("forwards explicit sessionIds in the recovery body", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { recovered: [] }));
    const client = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    await client.recoverSessions("march", undefined, ["s1", "s2"]);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ profile: "march", sessionIds: ["s1", "s2"] });
  });

  it("probes the authenticated /v1 surface for readiness", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { sessions: [] }));
    const ok = new CastraClient({
      baseUrl: "http://castra:9264",
      token: "secret",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(await ok.reachable()).toBe(true);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Hits an authenticated /v1 endpoint, not the open /healthz.
    expect(url).toBe("http://castra:9264/v1/sessions?profile=default");
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer secret");
  });

  it("reports not-ready on auth failure or transport error (never throws)", async () => {
    // A wrong/missing token yields 401 — readiness must be false even though
    // the server is up, because spawns would fail.
    const unauthorized = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: (async () =>
        jsonResponse(401, { error: { code: "unauthorized", message: "no" } })) as unknown as typeof fetch,
    });
    expect(await unauthorized.reachable()).toBe(false);

    const down = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: (async () => {
        throw new Error("nope");
      }) as unknown as typeof fetch,
    });
    expect(await down.reachable()).toBe(false);
  });
});

describe("castra client — stale keep-alive sockets (spawn worker blocked in docker wait)", () => {
  const transportError = (code: string) =>
    Object.assign(new TypeError("fetch failed"), { cause: Object.assign(new Error(`write ${code}`), { code }) });
  const sendReq = { profile: "march", sessionId: "s1", prompt: "go" };

  it("retries once on EPIPE (Castra never read the request) and succeeds", async () => {
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(transportError("EPIPE"))
      .mockResolvedValueOnce(jsonResponse(202, { accepted: true }));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendPrompt(sendReq)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("gives up after a second EPIPE and names the cause", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(transportError("EPIPE"));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendPrompt(sendReq)).rejects.toThrow(
      "Could not reach Castra at http://castra:9264: fetch failed (EPIPE: write EPIPE)",
    );
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not retry other transport failures (a send must never be typed twice)", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(transportError("ECONNRESET"));
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.sendPrompt(sendReq)).rejects.toThrow("(ECONNRESET: write ECONNRESET)");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("castra client — operation deadlines", () => {
  it("launch, send and remove wait out Castra's whole budget plus a margin", async () => {
    const budgets = await import("./budgets.js");
    const waits: number[] = [];
    const timeout = vi.spyOn(AbortSignal, "timeout").mockImplementation((ms: number) => {
      waits.push(ms);
      return new AbortController().signal;
    });
    try {
      const responses = [
        jsonResponse(201, { session: { sessionId: "s" } }),
        jsonResponse(202, { ok: true }),
        jsonResponse(200, { removed: true }),
      ];
      const fetchImpl = vi.fn(async () => responses.shift()!);
      const client = new CastraClient({ baseUrl: "http://castra:9264", token: "t", fetchImpl: fetchImpl as unknown as typeof fetch });
      await client.launchSession({ profile: "p", repoPath: "/r", branch: "b", title: "t" });
      await client.sendPrompt({ profile: "p", sessionId: "s", prompt: "go" });
      await client.removeSession({ profile: "p", sessionId: "s", pruneWorktree: true });
      expect(waits).toEqual([
        budgets.CASTRA_LAUNCH_BUDGET_MS + budgets.CASTRA_CLIENT_MARGIN_MS,
        budgets.CASTRA_SEND_BUDGET_MS + budgets.CASTRA_CLIENT_MARGIN_MS,
        budgets.CASTRA_REMOVE_BUDGET_MS + budgets.CASTRA_CLIENT_MARGIN_MS,
      ]);
    } finally {
      timeout.mockRestore();
    }
  });
});

describe("CastraClient.launchSession deadline", () => {
  it("aborts the launch when the caller's signal fires", async () => {
    const fetchImpl = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })) as unknown as typeof fetch;
    const client = new CastraClient({ baseUrl: "http://castra:9264", fetchImpl });
    const controller = new AbortController();
    const launch = client.launchSession({
      profile: "p", repoPath: "/repo", branch: "b", title: "t", signal: controller.signal,
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());
    controller.abort(new Error("steward deadline"));
    await expect(launch).rejects.toThrow();
  });
});
