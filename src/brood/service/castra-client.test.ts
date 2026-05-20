import { describe, expect, it, vi } from "vitest";
import {
  CastraClientError,
  castraConfigured,
  removeStewardSession,
  resolveCastraBaseUrl,
} from "./castra-client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("castra config helpers", () => {
  it("resolveCastraBaseUrl trims trailing slash; castraConfigured gates on the URL", () => {
    expect(resolveCastraBaseUrl({ MARCH_CASTRA_URL: "http://castra:9264/" })).toBe(
      "http://castra:9264",
    );
    expect(resolveCastraBaseUrl({})).toBeUndefined();
    expect(castraConfigured({ MARCH_CASTRA_URL: "http://castra:9264" })).toBe(true);
    expect(castraConfigured({})).toBe(false);
  });
});

describe("removeStewardSession", () => {
  it("DELETEs castra with profile + pruneWorktree=false and parses {removed}", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse(200, { ok: true, removed: true }),
    );
    const result = await removeStewardSession({
      sessionId: "ad-1",
      profile: "march",
      env: { MARCH_CASTRA_URL: "http://castra:9264", CASTRA_API_TOKEN: "tok" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result).toEqual({ removed: true, via: "castra" });
    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/v1/sessions/ad-1?");
    expect(url).toContain("profile=march");
    expect(url).toContain("pruneWorktree=false");
    expect((init.method ?? "").toUpperCase()).toBe("DELETE");
    expect((init.headers as Record<string, string>).authorization).toBe(
      "Bearer tok",
    );
  });

  it("treats castra 404 as an idempotent not-found", async () => {
    const result = await removeStewardSession({
      sessionId: "gone",
      profile: "march",
      env: { MARCH_CASTRA_URL: "http://castra:9264" },
      fetchImpl: (async () =>
        jsonResponse(404, { error: { code: "not_found", message: "no" } })) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      removed: false,
      via: "castra",
      detail: "session not found",
    });
  });

  it("throws CastraClientError on a castra error status", async () => {
    await expect(
      removeStewardSession({
        sessionId: "x",
        profile: "march",
        env: { MARCH_CASTRA_URL: "http://castra:9264" },
        fetchImpl: (async () =>
          jsonResponse(502, { error: { code: "agent_deck_error", message: "boom" } })) as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(CastraClientError);
  });

  it("falls back to agent-deck (no prune) when castra is unconfigured", async () => {
    const agentDeckImpl = vi.fn(() => ({ removed: true, via: "agent-deck" as const }));
    const result = await removeStewardSession({
      sessionId: "ad-2",
      profile: "march",
      env: {},
      agentDeckImpl,
    });
    expect(result).toEqual({ removed: true, via: "agent-deck" });
    expect(agentDeckImpl).toHaveBeenCalledWith("ad-2", "march");
  });
});
