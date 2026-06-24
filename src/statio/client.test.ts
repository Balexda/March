/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import { StatioClient, StatioClientError } from "./client.js";
import {
  resolveStatioBaseUrl,
  resolveStatioPort,
  resolveStatioToken,
  statioPort,
} from "./config.js";
import { StatioValidationError } from "./types.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("statio client config", () => {
  it("derives the deterministic default port", () => {
    expect(statioPort()).toBe(9689);
    expect(resolveStatioPort(undefined, {} as NodeJS.ProcessEnv)).toBe(9689);
  });

  it("accepts explicit and env port overrides", () => {
    expect(resolveStatioPort(9123, {} as NodeJS.ProcessEnv)).toBe(9123);
    expect(resolveStatioPort(undefined, { MARCH_STATIO_PORT: "9124" } as NodeJS.ProcessEnv)).toBe(
      9124,
    );
  });

  it("rejects invalid port overrides", () => {
    expect(() =>
      resolveStatioPort(undefined, { MARCH_STATIO_PORT: "9689x" } as NodeJS.ProcessEnv),
    ).toThrow(StatioValidationError);
    expect(() => resolveStatioPort(0, {} as NodeJS.ProcessEnv)).toThrow(StatioValidationError);
    expect(() =>
      resolveStatioPort(undefined, { MARCH_STATIO_PORT: "70000" } as NodeJS.ProcessEnv),
    ).toThrow(StatioValidationError);
  });

  it("resolves base URL and token from MARCH_STATIO_* env vars", () => {
    expect(
      resolveStatioBaseUrl({ MARCH_STATIO_URL: "http://statio:9689/" } as NodeJS.ProcessEnv),
    ).toBe("http://statio:9689");
    expect(resolveStatioBaseUrl({} as NodeJS.ProcessEnv)).toBe("http://localhost:9689");
    expect(resolveStatioToken({ MARCH_STATIO_TOKEN: " secret " } as NodeJS.ProcessEnv)).toBe(
      "secret",
    );
    expect(resolveStatioToken({ MARCH_STATIO_TOKEN: " " } as NodeJS.ProcessEnv)).toBeUndefined();
  });

});

describe("StatioClient", () => {
  it("returns documented wire shapes from the /v1 routes", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { repo: { owner: "Balexda/March", defaultBranch: "master" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          prs: [
            {
              number: 12,
              url: "https://example.test/pr/12",
              state: "OPEN",
              mergeable: "MERGEABLE",
              headBranch: "feature",
              title: "Change",
              checks: "PASS",
              createdAt: "2026-05-26T00:00:00Z",
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pr: {
            number: 12,
            url: "https://example.test/pr/12",
            state: "OPEN",
            mergeable: "MERGEABLE",
            reviewDecision: "APPROVED",
            headBranch: "feature",
            title: "Change",
            author: "dev",
            checks: "PASS",
            failedChecks: [],
            unresolvedThreads: [],
            threadCount: 0,
            needsResponseCount: 0,
          },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          threads: [
            {
              id: 1,
              bodyPreview: "Needs update",
              commentCount: 1,
              commentIds: [1],
            },
          ],
        }),
      );
    const client = new StatioClient({
      baseUrl: "http://statio:9689",
      token: "tok",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.repoInfo()).resolves.toEqual({
      owner: "Balexda/March",
      defaultBranch: "master",
    });
    await expect(client.listPrs({ head: "feature", author: "@me", state: "open" })).resolves.toHaveLength(
      1,
    );
    await expect(client.getPr(12)).resolves.toMatchObject({ number: 12, author: "dev" });
    await expect(client.reviewThreads(12)).resolves.toEqual([
      { id: 1, bodyPreview: "Needs update", commentCount: 1, commentIds: [1] },
    ]);

    expect(fetchImpl.mock.calls[1][0]).toBe(
      "http://statio:9689/v1/prs?head=feature&author=%40me&state=open",
    );
    expect(fetchImpl.mock.calls[2][0]).toBe("http://statio:9689/v1/prs/12");
    expect(fetchImpl.mock.calls[3][0]).toBe("http://statio:9689/v1/prs/12/review-threads");
  });

  it("forwards bearer token and slice trace headers", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { repo: { owner: "Balexda/March", defaultBranch: "master" } }),
      )
      .mockResolvedValueOnce(
        jsonResponse(200, {
          pr: {
            number: 12,
            url: "https://example.test/pr/12",
            state: "OPEN",
            mergeable: "MERGEABLE",
            reviewDecision: "APPROVED",
            headBranch: "feature",
            title: "Change",
            author: "dev",
            checks: "PASS",
            failedChecks: [],
            unresolvedThreads: [],
            threadCount: 0,
            needsResponseCount: 0,
          },
        }),
      );
    const client = new StatioClient({
      baseUrl: "http://statio:9689/",
      token: "tok",
      traceKey: "slice-5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await client.repoInfo();
    await client.getPr(12);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://statio:9689/v1/repo");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-march-slice-id"]).toBe("slice-5");

    const [prUrl, prInit] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit];
    expect(prUrl).toBe("http://statio:9689/v1/prs/12");
    const prHeaders = prInit.headers as Record<string, string>;
    expect(prHeaders.authorization).toBe("Bearer tok");
    expect(prHeaders["x-march-slice-id"]).toBe("slice-5");
  });

  it("maps non-2xx envelopes to typed errors preserving code and status", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { error: { code: "unauthorized", message: "bad token" } }),
    );
    const client = new StatioClient({
      baseUrl: "http://statio:9689",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.repoInfo()).rejects.toMatchObject({
      name: "StatioClientError",
      code: "unauthorized",
      status: 401,
      message: "bad token",
    });
  });

  it("maps transport failures to typed errors without envelope codes", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const client = new StatioClient({
      baseUrl: "http://statio:9689",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.getPr(12)).rejects.toMatchObject({
      name: "StatioClientError",
      code: undefined,
      status: undefined,
    });
    await expect(client.getPr(12)).rejects.toBeInstanceOf(StatioClientError);
  });

  it("probes the authenticated forge-backed /v1 surface for readiness", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(200, { repo: { owner: "Balexda/March", defaultBranch: "master" } }),
    );
    const client = new StatioClient({
      baseUrl: "http://statio:9689",
      token: "tok",
      traceKey: "slice-5",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    await expect(client.reachable()).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("http://statio:9689/v1/repo");
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer tok");
    expect(headers["x-march-slice-id"]).toBe("slice-5");
  });

  it("reports not-ready for wrong-token, forge-down, and transport failures without throwing", async () => {
    const wrongToken = new StatioClient({
      baseUrl: "http://statio:9689",
      fetchImpl: (async () =>
        jsonResponse(401, { error: { code: "unauthorized", message: "no" } })) as unknown as typeof fetch,
    });
    await expect(wrongToken.reachable()).resolves.toBe(false);

    const forgeDown = new StatioClient({
      baseUrl: "http://statio:9689",
      fetchImpl: (async () =>
        jsonResponse(502, { error: { code: "forge_error", message: "gh down" } })) as unknown as typeof fetch,
    });
    await expect(forgeDown.reachable()).resolves.toBe(false);

    const transportDown = new StatioClient({
      baseUrl: "http://statio:9689",
      fetchImpl: (async () => {
        throw new Error("no route");
      }) as unknown as typeof fetch,
    });
    await expect(transportDown.reachable()).resolves.toBe(false);
  });
});
