/**
 * @l1 @deterministic @ci
 */
import { describe, expect, it, vi } from "vitest";
import {
  BroodClient,
  BroodClientError,
  BroodNotFoundError,
  BroodUnavailableError,
  resolveBroodUrl,
} from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveBroodUrl", () => {
  it("prefers MARCH_BROOD_URL, strips trailing slash", () => {
    expect(resolveBroodUrl({ MARCH_BROOD_URL: "http://brood:9000/" })).toBe(
      "http://brood:9000",
    );
  });

  it("falls back to the deterministic localhost port", () => {
    expect(resolveBroodUrl({})).toMatch(/^http:\/\/localhost:\d+$/);
  });
});

describe("BroodClient", () => {
  it("register POSTs /sessions and returns the record", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse(201, { id: "s1", kind: "spawn", status: "created" }),
    );
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    const rec = await client.register({ id: "s1", kind: "spawn" });
    expect(rec.id).toBe("s1");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://brood/sessions");
    expect((init as RequestInit).method).toBe("POST");
  });

  it("propagates the traceparent header when provided", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse(201, { id: "s1" }),
    );
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      traceparent: "00-abc-def-01",
    });
    await client.register({ id: "s1", kind: "spawn" });
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).traceparent).toBe("00-abc-def-01");
  });

  it("get returns undefined on 404", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => jsonResponse(404, { error: "no" })) as unknown as typeof fetch,
    });
    expect(await client.get("missing")).toBeUndefined();
  });

  it("getExtractionReadiness reads the stable PR-readiness view", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) =>
      jsonResponse(200, {
        spawnId: "s1",
        status: "missing",
        prReady: false,
      }),
    );
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(await client.getExtractionReadiness("s1")).toEqual({
      spawnId: "s1",
      status: "missing",
      prReady: false,
    });
    expect(fetchImpl.mock.calls[0][0]).toBe(
      "http://brood/sessions/s1/extraction-readiness",
    );
  });

  it("getExtractionReadiness returns undefined on 404", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => jsonResponse(404, { error: "no" })) as unknown as typeof fetch,
    });
    expect(await client.getExtractionReadiness("missing")).toBeUndefined();
  });

  it("list returns the sessions array", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () =>
        jsonResponse(200, { sessions: [{ id: "a" }, { id: "b" }] })) as unknown as typeof fetch,
    });
    const sessions = await client.list({ kind: "spawn" });
    expect(sessions.map((s) => s.id)).toEqual(["a", "b"]);
  });

  it("teardown returns the result", async () => {
    const result = { id: "s1", status: "torndown", steps: [], warnings: [] };
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => jsonResponse(200, result)) as unknown as typeof fetch,
    });
    expect(await client.teardown("s1", { force: true })).toEqual(result);
  });

  it("teardown throws BroodNotFoundError on 404 (idempotent no-op for callers)", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () =>
        jsonResponse(404, { error: "no session" })) as unknown as typeof fetch,
    });
    await expect(client.teardown("ghost")).rejects.toBeInstanceOf(
      BroodNotFoundError,
    );
  });

  it("raises BroodClientError on a non-2xx with the server message", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => jsonResponse(500, { error: "boom" })) as unknown as typeof fetch,
    });
    await expect(client.register({ id: "s1", kind: "spawn" })).rejects.toThrowError(
      /boom/,
    );
  });

  it("raises BroodUnavailableError when the fetch itself fails", async () => {
    const client = new BroodClient({
      baseUrl: "http://brood",
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    await expect(client.list()).rejects.toBeInstanceOf(BroodUnavailableError);
  });
});
