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

  it("reports reachability without throwing", async () => {
    const ok = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: (async () => new Response("ok", { status: 200 })) as unknown as typeof fetch,
    });
    expect(await ok.reachable()).toBe(true);

    const down = new CastraClient({
      baseUrl: "http://castra:9264",
      fetchImpl: (async () => {
        throw new Error("nope");
      }) as unknown as typeof fetch,
    });
    expect(await down.reachable()).toBe(false);
  });
});
