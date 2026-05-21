import { describe, expect, it, vi } from "vitest";
import {
  HeraldClient,
  HeraldClientError,
  HeraldUnavailableError,
  heraldConfigured,
  resolveHeraldUrl,
} from "./client.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(body === undefined ? "" : JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("resolveHeraldUrl / heraldConfigured", () => {
  it("prefers MARCH_HERALD_URL and strips trailing slash", () => {
    expect(resolveHeraldUrl({ MARCH_HERALD_URL: "http://herald:9000/" } as NodeJS.ProcessEnv)).toBe("http://herald:9000");
  });
  it("falls back to the deterministic localhost port", () => {
    expect(resolveHeraldUrl({} as NodeJS.ProcessEnv)).toMatch(/^http:\/\/localhost:\d+$/);
  });
  it("heraldConfigured reflects MARCH_HERALD_URL presence", () => {
    expect(heraldConfigured({ MARCH_HERALD_URL: "http://h" } as NodeJS.ProcessEnv)).toBe(true);
    expect(heraldConfigured({} as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("HeraldClient", () => {
  it("events() GETs /events?after= and returns the page", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(200, { events: [{ seq: 3 }], lastSeq: 3 }));
    const client = new HeraldClient({ baseUrl: "http://herald", fetchImpl: fetchImpl as unknown as typeof fetch });
    const page = await client.events({ after: 2, limit: 50 });
    expect(page.lastSeq).toBe(3);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://herald/events?after=2&limit=50");
  });

  it("append() POSTs /events with source=legate and returns the stored event", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(201, { seq: 7, type: "slice.archived" }));
    const client = new HeraldClient({ baseUrl: "http://herald", fetchImpl: fetchImpl as unknown as typeof fetch });
    const ev = await client.append({ type: "slice.archived", sliceId: "s1" });
    expect(ev.seq).toBe(7);
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("POST");
    expect(JSON.parse(init.body as string)).toMatchObject({ source: "legate", type: "slice.archived", sliceId: "s1" });
  });

  it("state() and delta() hit the right paths", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(200, { from: 1, to: 3, events: [], seq: 3 }));
    const client = new HeraldClient({ baseUrl: "http://herald", fetchImpl: fetchImpl as unknown as typeof fetch });
    await client.state(5);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://herald/state?at=5");
    await client.delta(1, 3);
    expect(fetchImpl.mock.calls[1][0]).toBe("http://herald/state/delta?from=1&to=3");
  });

  it("propagates the traceparent header when provided", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(200, { events: [], lastSeq: 0 }));
    const client = new HeraldClient({
      baseUrl: "http://herald",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      traceparent: "00-abc-def-01",
    });
    await client.events();
    const init = fetchImpl.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).traceparent).toBe("00-abc-def-01");
  });

  it("raises HeraldUnavailableError on a connection failure", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => {
      throw new TypeError("fetch failed");
    });
    const client = new HeraldClient({ baseUrl: "http://herald", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.events()).rejects.toBeInstanceOf(HeraldUnavailableError);
  });

  it("raises HeraldClientError on a non-2xx response", async () => {
    const fetchImpl = vi.fn(async (..._args: unknown[]) => jsonResponse(500, { error: "boom" }));
    const client = new HeraldClient({ baseUrl: "http://herald", fetchImpl: fetchImpl as unknown as typeof fetch });
    await expect(client.state()).rejects.toBeInstanceOf(HeraldClientError);
  });
});
