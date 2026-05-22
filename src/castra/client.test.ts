import { describe, it, expect, vi, afterEach } from "vitest";

const cp = vi.hoisted(() => ({ execFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({ execFileSync: cp.execFileSync }));

import {
  CastraClient,
  CastraClientError,
  SyncCastraClient,
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

describe("SyncCastraClient (curl transport)", () => {
  afterEach(() => cp.execFileSync.mockReset());

  // curl emits the body followed by `\n<http_code>` (the client's -w format).
  const reply = (body: unknown, code = 200) =>
    `${typeof body === "string" ? body : JSON.stringify(body)}\n${code}`;

  const client = () =>
    new SyncCastraClient({ baseUrl: "http://castra:9264", token: "tok" });

  it("lists sessions and sends the bearer token + profile query via curl", () => {
    cp.execFileSync.mockReturnValue(
      reply({
        sessions: [
          { sessionId: "s1", title: "St", group: "g", branch: "b", worktreePath: "/w", createdAt: "t", status: "running" },
        ],
      }),
    );
    const sessions = client().listSessions("smithy");
    expect(sessions[0]).toMatchObject({ sessionId: "s1", status: "running" });
    const args = cp.execFileSync.mock.calls[0][1] as string[];
    expect(args).toContain("authorization: Bearer tok");
    expect(args.some((a) => a.includes("/v1/sessions?profile=smithy"))).toBe(true);
  });

  it("sends createBranch:false only for an attach launch", () => {
    cp.execFileSync.mockReturnValue(
      reply({ session: { sessionId: "s2", title: "t", group: "g", branch: "b", worktreePath: "/w", createdAt: "c", status: "idle" } }, 201),
    );
    client().launchSession({ profile: "smithy", repoPath: "/r", branch: "b", title: "t", createBranch: false });
    const args = cp.execFileSync.mock.calls[0][1] as string[];
    const body = JSON.parse(args[args.indexOf("--data-binary") + 1]!);
    expect(body.createBranch).toBe(false);
  });

  it("maps a non-2xx envelope to CastraClientError with code + status", () => {
    cp.execFileSync.mockReturnValue(reply({ error: { code: "not_found", message: "gone" } }, 404));
    try {
      client().sessionOutput("smithy", "s1");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(CastraClientError);
      expect((err as CastraClientError).status).toBe(404);
      expect((err as CastraClientError).code).toBe("not_found");
      expect((err as Error).message).toBe("gone");
    }
  });

  it("treats DELETE removed flag as the result", () => {
    cp.execFileSync.mockReturnValue(reply({ ok: true, removed: true }));
    expect(client().removeSession({ profile: "smithy", sessionId: "s1", pruneWorktree: true })).toEqual({
      removed: true,
    });
  });
});
