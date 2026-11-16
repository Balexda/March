/**
 * @l1 @deterministic @ci
 *
 * The Tessera Node client against an injected fake `fetch` (no network), plus
 * one integration pass against the real in-process Tessera server.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClientRegistry } from "./auth/client-keys.js";
import { parsePolicy } from "./auth/policy.js";
import {
  DEFAULT_TESSERA_TIMEOUT_MS,
  type GitHubTokenRequest,
  TESSERA_REUSE_MARGIN_MS,
  TESSERA_SLICE_ID_HEADER,
  TesseraClient,
  TesseraClientError,
} from "./client.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";
import {
  type CredentialProvider,
  type Entitlement,
  type ProviderIssueResult,
  TesseraError,
} from "./types.js";

const CLIENT_KEY = "tessera-client-test-key-do-not-leak";
const TOKEN = "ghs_CLIENTTESTSECRETTOKEN0123456789";
const BASE_URL = "http://tessera.test:9477";

const WIRE: Entitlement = {
  token: TOKEN,
  expires_at: "2026-11-15T19:04:11Z",
  identity: "march-bot[bot]",
  commit_identity: {
    name: "march-bot[bot]",
    email: "123456+march-bot[bot]@users.noreply.github.com",
  },
  access: "write",
  repo: "acme/widgets",
};

const APP_WRITE: GitHubTokenRequest = { identity: "app", repo: "acme/widgets", access: "write" };

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function envelope(code: string, message: string, status: number, headers?: Record<string, string>) {
  return jsonResponse({ error: { code, message } }, status, headers);
}

type FetchMock = ReturnType<typeof vi.fn<typeof fetch>>;

function fakeFetch(respond: () => Response | Promise<Response> = () => jsonResponse(WIRE)): FetchMock {
  return vi.fn<typeof fetch>(async () => respond());
}

function client(fetchImpl: FetchMock, extra: Partial<ConstructorParameters<typeof TesseraClient>[0]> = {}) {
  return new TesseraClient({ baseUrl: BASE_URL, clientKey: CLIENT_KEY, env: {}, fetchImpl, ...extra });
}

async function captureError(promise: Promise<unknown>): Promise<TesseraClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TesseraClientError);
    expect(err).not.toBeInstanceOf(TesseraError);
    const typed = err as TesseraClientError;
    expect(typed.message).not.toContain(CLIENT_KEY);
    expect(typed.message).not.toContain(TOKEN);
    expect(String(typed.stack)).not.toContain(CLIENT_KEY);
    return typed;
  }
  throw new Error("expected the call to reject");
}

function lastInit(fetchImpl: FetchMock): RequestInit {
  const call = fetchImpl.mock.calls.at(-1);
  if (!call) throw new Error("fetch was not called");
  return call[1] ?? {};
}

function headersOf(init: RequestInit): Record<string, string> {
  return init.headers as Record<string, string>;
}

describe("TesseraClient.issueGitHubToken", () => {
  it("posts to the token route with the bearer key and the request body", async () => {
    const fetchImpl = fakeFetch();
    await client(fetchImpl).issueGitHubToken(APP_WRITE);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe(`${BASE_URL}/v1/github/token`);
    const init = lastInit(fetchImpl);
    expect(init.method).toBe("POST");
    const headers = headersOf(init);
    expect(headers.authorization).toBe(`Bearer ${CLIENT_KEY}`);
    expect(headers["content-type"]).toBe("application/json");
    expect(headers[TESSERA_SLICE_ID_HEADER]).toBeUndefined();
    expect(JSON.parse(String(init.body))).toEqual({
      identity: "app",
      repo: "acme/widgets",
      access: "write",
    });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("sends refresh in the body and the slice id only as a header", async () => {
    const fetchImpl = fakeFetch();
    await client(fetchImpl).issueGitHubToken({ ...APP_WRITE, refresh: true, sliceId: "slice-42" });

    const init = lastInit(fetchImpl);
    expect(TESSERA_SLICE_ID_HEADER).toBe("x-march-slice-id");
    expect(headersOf(init)[TESSERA_SLICE_ID_HEADER]).toBe("slice-42");
    const body = JSON.parse(String(init.body));
    expect(body).toEqual({ identity: "app", repo: "acme/widgets", access: "write", refresh: true });
    expect(body).not.toHaveProperty("sliceId");
  });

  it("omits the repo for a user request without one", async () => {
    const fetchImpl = fakeFetch(() =>
      jsonResponse({ ...WIRE, identity: "operator", commit_identity: null, repo: null }),
    );
    const result = await client(fetchImpl).issueGitHubToken({ identity: "user", access: "read" });
    expect(JSON.parse(String(lastInit(fetchImpl).body))).toEqual({ identity: "user", access: "read" });
    expect(result.commitIdentity).toBeNull();
    expect(result.identity).toBe("operator");
  });

  it("maps the wire entitlement to a GitHubEntitlement", async () => {
    const result = await client(fakeFetch()).issueGitHubToken(APP_WRITE);
    expect(result).toEqual({
      token: TOKEN,
      expiresAt: "2026-11-15T19:04:11Z",
      identity: "march-bot[bot]",
      commitIdentity: {
        name: "march-bot[bot]",
        email: "123456+march-bot[bot]@users.noreply.github.com",
      },
      source: "tessera",
    });
  });

  it("maps a null expiry through unchanged", async () => {
    const fetchImpl = fakeFetch(() => jsonResponse({ ...WIRE, expires_at: null }));
    const result = await client(fetchImpl).issueGitHubToken(APP_WRITE);
    expect(result.expiresAt).toBeNull();
  });

  it("resolves the base URL and client key from the env when not given", async () => {
    const fetchImpl = fakeFetch();
    const c = new TesseraClient({
      env: { MARCH_TESSERA_URL: "http://env-tessera:1234/", MARCH_TESSERA_CLIENT_KEY: CLIENT_KEY },
      fetchImpl,
    });
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe("http://env-tessera:1234/v1/github/token");
    expect(headersOf(lastInit(fetchImpl)).authorization).toBe(`Bearer ${CLIENT_KEY}`);
  });

  it("strips trailing slashes from an explicit base URL", async () => {
    const fetchImpl = fakeFetch();
    await client(fetchImpl, { baseUrl: `${BASE_URL}//` }).issueGitHubToken(APP_WRITE);
    expect(fetchImpl.mock.calls[0]?.[0]).toBe(`${BASE_URL}/v1/github/token`);
  });

  it.each([
    ["unauthorized", 401],
    ["policy_denied", 403],
    ["invalid_request", 400],
    ["repo_not_installed", 422],
    ["provider_unconfigured", 503],
    ["credential_invalid", 503],
    ["mint_failed", 502],
    ["internal", 500],
  ])("preserves the server's %s code and %i status", async (code, status) => {
    const fetchImpl = fakeFetch(() => envelope(code, `server says ${code}`, status));
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
    expect(err.message).toBe(`server says ${code}`);
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("carries the Retry-After delay on provider_unavailable", async () => {
    const fetchImpl = fakeFetch(() =>
      envelope("provider_unavailable", "GitHub is down.", 503, { "retry-after": "30" }),
    );
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("provider_unavailable");
    expect(err.status).toBe(503);
    expect(err.retryAfterSeconds).toBe(30);
  });

  it("ignores a non-numeric Retry-After header", async () => {
    const fetchImpl = fakeFetch(() =>
      envelope("provider_unavailable", "GitHub is down.", 503, {
        "retry-after": "Wed, 21 Oct 2026 07:28:00 GMT",
      }),
    );
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.retryAfterSeconds).toBeUndefined();
  });

  it("reports a network failure as unreachable without echoing the cause", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      throw new TypeError(`fetch failed for Bearer ${CLIENT_KEY}`);
    });
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBeUndefined();
  });

  it("times out a hanging request as unreachable within the bound", async () => {
    const fetchImpl = vi.fn<typeof fetch>(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        }),
    );
    const started = Date.now();
    const err = await captureError(client(fetchImpl, { timeoutMs: 50 }).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("defaults the timeout to ten seconds", () => {
    expect(DEFAULT_TESSERA_TIMEOUT_MS).toBe(10_000);
  });

  it("reports a non-JSON error response as unreachable with its status", async () => {
    const fetchImpl = fakeFetch(() => new Response("<html>bad gateway</html>", { status: 502 }));
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBe(502);
  });

  it.each([
    ["no envelope", { message: "nope" }],
    ["an unknown code", { error: { code: "teapot", message: "short and stout" } }],
    ["a non-string message", { error: { code: "internal", message: 7 } }],
  ])("reports an error response with %s as unreachable", async (_label, body) => {
    const fetchImpl = fakeFetch(() => jsonResponse(body, 500));
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBe(500);
  });

  it.each([
    ["no token", { ...WIRE, token: undefined }],
    ["an empty token", { ...WIRE, token: "" }],
    ["a non-string identity", { ...WIRE, identity: 5 }],
    ["a bad expiry", { ...WIRE, expires_at: 5 }],
    ["a bad commit identity", { ...WIRE, commit_identity: { name: "x" } }],
    ["a non-object body", [WIRE]],
  ])("reports a 2xx body with %s as unreachable", async (_label, body) => {
    const fetchImpl = fakeFetch(() => jsonResponse(body, 200));
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
    expect(err.status).toBe(200);
  });

  it("reports a non-JSON 2xx body as unreachable", async () => {
    const fetchImpl = fakeFetch(() => new Response("ok", { status: 200 }));
    const err = await captureError(client(fetchImpl).issueGitHubToken(APP_WRITE));
    expect(err.code).toBe("unreachable");
  });

  it("raises client_key_missing before any request when no key is configured", async () => {
    const fetchImpl = fakeFetch();
    for (const c of [
      new TesseraClient({ baseUrl: BASE_URL, env: {}, fetchImpl }),
      new TesseraClient({ baseUrl: BASE_URL, env: { MARCH_TESSERA_CLIENT_KEY: "  " }, fetchImpl }),
      new TesseraClient({ baseUrl: BASE_URL, clientKey: "", env: {}, fetchImpl }),
    ]) {
      const err = await captureError(c.issueGitHubToken(APP_WRITE));
      expect(err.code).toBe("client_key_missing");
      expect(err.status).toBeUndefined();
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([
    ["app without a repo", { identity: "app", access: "read" }],
    ["a malformed repo", { identity: "app", repo: "acme", access: "read" }],
    ["a dot-only repo segment", { identity: "app", repo: "acme/..", access: "read" }],
    ["an unknown identity", { identity: "root", repo: "acme/widgets", access: "read" }],
    ["an unknown access", { identity: "app", repo: "acme/widgets", access: "admin" }],
    ["a non-boolean refresh", { identity: "app", repo: "acme/widgets", access: "read", refresh: "y" }],
    ["a non-string slice id", { identity: "app", repo: "acme/widgets", access: "read", sliceId: 9 }],
  ])("raises invalid_request before any request for %s", async (_label, req) => {
    const fetchImpl = fakeFetch();
    const err = await captureError(
      client(fetchImpl).issueGitHubToken(req as unknown as GitHubTokenRequest),
    );
    expect(err.code).toBe("invalid_request");
    expect(err.status).toBeUndefined();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not import the server module", () => {
    const source = readFileSync(fileURLToPath(new URL("./client.ts", import.meta.url)), "utf8");
    const imports = [...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).not.toMatch(/server(\.js)?$/);
  });
});

describe("TesseraClient entitlement reuse", () => {
  const EXPIRY = Date.parse("2026-11-15T20:00:00Z");
  const MINUTE = 60_000;

  /** A fetch that answers each call with a fresh token expiring at EXPIRY. */
  function countingFetch(expiresAt: string | null = new Date(EXPIRY).toISOString()): FetchMock {
    let n = 0;
    return vi.fn<typeof fetch>(async () => {
      n += 1;
      return jsonResponse({ ...WIRE, token: `${TOKEN}-${n}`, expires_at: expiresAt });
    });
  }

  function clocked(fetchImpl: FetchMock) {
    let at = EXPIRY - 60 * MINUTE;
    const c = client(fetchImpl, { now: () => at });
    return { c, set: (ms: number) => (at = ms) };
  }

  it("reuses an entitlement with more than ten minutes left without calling Tessera", async () => {
    expect(TESSERA_REUSE_MARGIN_MS).toBe(10 * MINUTE);
    const fetchImpl = countingFetch();
    const { c, set } = clocked(fetchImpl);
    const first = await c.issueGitHubToken(APP_WRITE);
    set(EXPIRY - 10 * MINUTE - 1);
    const second = await c.issueGitHubToken({ ...APP_WRITE, sliceId: "another-slice" });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("fetches a new entitlement inside the final ten minutes", async () => {
    const fetchImpl = countingFetch();
    const { c, set } = clocked(fetchImpl);
    await c.issueGitHubToken(APP_WRITE);
    set(EXPIRY - 10 * MINUTE);
    const second = await c.issueGitHubToken(APP_WRITE);
    expect(second.token).toBe(`${TOKEN}-2`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // The new entry replaces the old one.
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("always fetches on refresh, forwards it, and replaces the entry", async () => {
    const fetchImpl = countingFetch();
    const { c } = clocked(fetchImpl);
    await c.issueGitHubToken(APP_WRITE);
    const refreshed = await c.issueGitHubToken({ ...APP_WRITE, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(lastInit(fetchImpl).body)).refresh).toBe(true);
    expect(refreshed.token).toBe(`${TOKEN}-2`);
    const reused = await c.issueGitHubToken(APP_WRITE);
    expect(reused.token).toBe(`${TOKEN}-2`);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("keeps entries apart by identity, repository and access, ignoring repository case", async () => {
    const fetchImpl = countingFetch();
    const { c } = clocked(fetchImpl);
    const requests: GitHubTokenRequest[] = [
      { identity: "app", repo: "acme/widgets", access: "write" },
      { identity: "app", repo: "acme/widgets", access: "read" },
      { identity: "app", repo: "acme/gadgets", access: "write" },
      { identity: "user", repo: "acme/widgets", access: "write" },
      { identity: "user", access: "write" },
    ];
    const tokens = new Set<string>();
    for (const req of requests) tokens.add((await c.issueGitHubToken(req)).token);
    expect(tokens.size).toBe(requests.length);
    expect(fetchImpl).toHaveBeenCalledTimes(requests.length);

    const upper = await c.issueGitHubToken({ identity: "app", repo: "ACME/Widgets", access: "write" });
    expect(upper.token).toBe(`${TOKEN}-1`);
    expect(fetchImpl).toHaveBeenCalledTimes(requests.length);
  });

  it.each([
    ["no expiry", null],
    ["an unparseable expiry", "not-a-date"],
  ])("never caches an entitlement with %s", async (_label, expiresAt) => {
    const fetchImpl = countingFetch(expiresAt);
    const { c } = clocked(fetchImpl);
    await c.issueGitHubToken(APP_WRITE);
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("never caches a failure, and a plain failure leaves a valid entry alone", async () => {
    let fail = true;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      fail ? envelope("mint_failed", "mint failed", 502) : jsonResponse(WIRE),
    );
    let at = Date.parse(WIRE.expires_at as string) - 60 * MINUTE;
    const c = client(fetchImpl, { now: () => at });

    await captureError(c.issueGitHubToken(APP_WRITE));
    fail = false;
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    // A failed refresh evicts the entry it was asked to replace.
    fail = true;
    await captureError(c.issueGitHubToken({ ...APP_WRITE, refresh: true }));
    fail = false;
    at += MINUTE;
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
    await c.issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("does not let a caller mutate the cached entry", async () => {
    const fetchImpl = countingFetch();
    const { c } = clocked(fetchImpl);
    const first = await c.issueGitHubToken(APP_WRITE);
    expect(() => {
      (first as { token: string }).token = "tampered";
    }).toThrow(TypeError);
    expect(() => {
      (first.commitIdentity as { name: string }).name = "tampered";
    }).toThrow(TypeError);
    const second = await c.issueGitHubToken(APP_WRITE);
    expect(second.token).toBe(`${TOKEN}-1`);
    expect(second.commitIdentity?.name).toBe("march-bot[bot]");
  });

  it("keeps the cache per instance", async () => {
    const fetchImpl = countingFetch();
    const now = () => EXPIRY - 60 * MINUTE;
    await client(fetchImpl, { now }).issueGitHubToken(APP_WRITE);
    await client(fetchImpl, { now }).issueGitHubToken(APP_WRITE);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe("TesseraClient against the real Tessera server", () => {
  const OTHER_KEY = "tessera-client-other-key-do-not-leak";
  const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
  const clients = parseClientRegistry(
    JSON.stringify([{ client: "herald", key_sha256: sha256Hex(CLIENT_KEY) }]),
  );
  const policy = parsePolicy(
    JSON.stringify([{ client: "herald", identities: ["app"], repos: ["acme/*"], max_access: "read" }]),
    clients.clients(),
  );
  const provider: CredentialProvider = {
    id: "github-app",
    identity: "app",
    start: async () => undefined,
    issue: async (): Promise<ProviderIssueResult> => ({
      token: TOKEN,
      expiresAt: "2026-11-15T19:04:11Z",
      identity: "march-bot[bot]",
      commitIdentity: { name: "march-bot[bot]", email: "1+march-bot[bot]@users.noreply.github.com" },
      cache: "miss",
    }),
    status: () => ({
      provider: "github-app",
      state: "ok",
      login: "march-bot[bot]",
      credential_expires_at: null,
      expiry_warning: false,
      last_error: null,
    }),
  };

  let app: FastifyInstance | undefined;
  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  async function startServer(): Promise<string> {
    app = buildTesseraServer({ clients, policy, registry: createProviderRegistry([provider]) });
    await app.listen({ host: "127.0.0.1", port: 0 });
    const address = app.server.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  it("issues, is refused with a wrong key, and is denied by policy", async () => {
    const baseUrl = await startServer();

    const ok = await new TesseraClient({ baseUrl, clientKey: CLIENT_KEY, env: {} }).issueGitHubToken({
      identity: "app",
      repo: "acme/widgets",
      access: "read",
      sliceId: "slice-1",
    });
    expect(ok).toEqual({
      token: TOKEN,
      expiresAt: "2026-11-15T19:04:11Z",
      identity: "march-bot[bot]",
      commitIdentity: { name: "march-bot[bot]", email: "1+march-bot[bot]@users.noreply.github.com" },
      source: "tessera",
    });

    const refused = await captureError(
      new TesseraClient({ baseUrl, clientKey: OTHER_KEY, env: {} }).issueGitHubToken({
        identity: "app",
        repo: "acme/widgets",
        access: "read",
      }),
    );
    expect(refused.code).toBe("unauthorized");
    expect(refused.status).toBe(401);
    expect(refused.message).not.toContain(OTHER_KEY);

    const denied = await captureError(
      new TesseraClient({ baseUrl, clientKey: CLIENT_KEY, env: {} }).issueGitHubToken({
        identity: "app",
        repo: "acme/widgets",
        access: "write",
      }),
    );
    expect(denied.code).toBe("policy_denied");
    expect(denied.status).toBe(403);
  });
});
