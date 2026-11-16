/**
 * @l1 @deterministic @ci
 *
 * HTTP contract test for the Tessera token route, `/healthz` and `/status`,
 * driven through an injected provider registry: first with stub providers,
 * then with the real github-app provider against the fake GitHub API.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { SpanStatusCode } from "@opentelemetry/api";
import type { Span } from "@opentelemetry/sdk-trace-base";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { createTesseraLogger } from "../observability/logger.js";
import { getActiveOtel, initOtel } from "../observability/otel.js";
import { spanIdForDispatch, traceIdForDispatch } from "../observability/trace-ids.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESSERA_SERVICE_NAME } from "./config.js";
import { GitHubClient } from "./providers/github-app/github-client.js";
import { createGitHubAppProvider } from "./providers/github-app/provider.js";
import { parseClientRegistry } from "./auth/client-keys.js";
import { parsePolicy } from "./auth/policy.js";
import { startFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "./testing/fake-github.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";
import {
  ACCESS_PROFILES,
  CredentialInvalidError,
  type CredentialProvider,
  type Identity,
  MintFailedError,
  POLICY_DENIED_MESSAGES,
  type PolicyDimension,
  type ProviderId,
  type ProviderIssueRequest,
  type ProviderIssueResult,
  type ProviderStatus,
  ProviderUnavailableError,
  ProviderUnconfiguredError,
  RepoNotInstalledError,
  type TesseraError,
  TESSERA_SLICE_ID_HEADER,
  UNAUTHORIZED_MESSAGE,
} from "./types.js";

const SECRET_TOKEN = "ghs_SECRETTOKENVALUE1234567890";

/** The test caller's bearer key; only its SHA-256 is registered. */
const CLIENT_KEY = "tessera-test-client-key-do-not-log";
const OTHER_CLIENT_KEY = "tessera-other-client-key-do-not-log";
const RULELESS_CLIENT_KEY = "tessera-ruleless-client-key-do-not-log";
const sha256Hex = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const CLIENT_KEY_SHA256 = sha256Hex(CLIENT_KEY);
const CLIENTS = parseClientRegistry(
  JSON.stringify([
    { client: "herald", key_sha256: CLIENT_KEY_SHA256 },
    { client: "legate", key_sha256: sha256Hex(OTHER_CLIENT_KEY) },
    { client: "brood", key_sha256: sha256Hex(RULELESS_CLIENT_KEY) },
  ]),
);
/** herald's key: `app` read on any `acme` repository. */
const AUTH = `Bearer ${CLIENT_KEY}`;
/** legate's key: `app` + `user` write on its allowlist. */
const LEGATE_AUTH = `Bearer ${OTHER_CLIENT_KEY}`;
/** brood's key: registered, but brood has no policy rule. */
const RULELESS_AUTH = `Bearer ${RULELESS_CLIENT_KEY}`;
/** Allowlist entries no response body or log line may ever contain. */
const ALLOWLIST_ENTRIES = ["acme/*", "acme/widgets", "acme/secret-repo", "octo/*"] as const;
const POLICY = parsePolicy(
  JSON.stringify([
    { client: "herald", identities: ["app"], repos: ["acme/*"], max_access: "read" },
    {
      client: "legate",
      identities: ["app", "user"],
      repos: ["acme/widgets", "acme/secret-repo", "octo/*"],
      max_access: "write",
    },
  ]),
  CLIENTS.clients(),
);

interface StubOptions {
  readonly id?: ProviderId;
  readonly identity?: Identity;
  readonly status?: Partial<ProviderStatus>;
  readonly issue?: (req: ProviderIssueRequest) => Promise<ProviderIssueResult>;
  readonly cacheEntries?: number;
}

function stubProvider(options: StubOptions = {}): CredentialProvider & {
  issue: ReturnType<typeof vi.fn>;
} {
  const id = options.id ?? "github-app";
  const identity = options.identity ?? "app";
  const issue = vi.fn(
    options.issue ??
      (async (): Promise<ProviderIssueResult> => ({
        token: SECRET_TOKEN,
        expiresAt: "2026-11-15T19:04:11Z",
        identity: "march-bot[bot]",
        commitIdentity: {
          name: "march-bot[bot]",
          email: "123456+march-bot[bot]@users.noreply.github.com",
        },
        cache: "miss",
      })),
  );
  const provider: CredentialProvider & { issue: typeof issue } = {
    id,
    identity,
    start: async () => undefined,
    issue,
    status: () => ({
      provider: id,
      state: "ok",
      login: "march-bot[bot]",
      credential_expires_at: null,
      expiry_warning: false,
      last_error: null,
      ...options.status,
    }),
  };
  if (options.cacheEntries !== undefined) {
    const count = options.cacheEntries;
    return { ...provider, cacheEntries: () => count };
  }
  return provider;
}

function unconfiguredAppProvider(): CredentialProvider & { issue: ReturnType<typeof vi.fn> } {
  return stubProvider({
    status: { state: "unconfigured", login: null },
    issue: async () => {
      throw new ProviderUnconfiguredError("GitHub App is not configured.");
    },
  });
}

describe("tessera server", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
  });

  async function postToken(body: unknown, raw?: string, authorization: string = AUTH) {
    if (!app) throw new Error("app not built");
    return app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: { "content-type": "application/json", authorization },
      payload: raw ?? JSON.stringify(body),
    });
  }

  it("answers /healthz with ok", async () => {
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports the minimal /status shape", async () => {
    const startedAt = Date.now() - 5_000;
    app = buildTesseraServer({
      clients: CLIENTS, policy: POLICY,
      registry: createProviderRegistry([unconfiguredAppProvider()]),
      startedAt,
    });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Object.keys(body).sort()).toEqual(
      ["cache", "providers", "service", "soonest_expiry", "uptime_s"].sort(),
    );
    expect(body.service).toBe(TESSERA_SERVICE_NAME);
    expect(body.uptime_s).toBeGreaterThanOrEqual(5);
    expect(body.providers).toEqual([
      {
        provider: "github-app",
        state: "unconfigured",
        login: null,
        credential_expires_at: null,
        expiry_warning: false,
        last_error: null,
      },
    ]);
    expect(body.soonest_expiry).toBeNull();
    expect(body.cache).toEqual({ entries: 0 });
  });

  it("reports the soonest expiry and summed cache entries from providers", async () => {
    app = buildTesseraServer({
      clients: CLIENTS, policy: POLICY,
      registry: createProviderRegistry([
        stubProvider({
          status: { credential_expires_at: "2027-01-01T00:00:00Z" },
          cacheEntries: 2,
        }),
        stubProvider({
          id: "github-user",
          identity: "user",
          status: { credential_expires_at: "2026-12-01T00:00:00Z" },
          cacheEntries: 1,
        }),
      ]),
    });
    const body = (await app.inject({ method: "GET", url: "/status" })).json();
    expect(body.soonest_expiry).toBe("2026-12-01T00:00:00Z");
    expect(body.cache).toEqual({ entries: 3 });
  });

  it("reports a provider whose status() throws as degraded instead of failing /status", async () => {
    const healthy = stubProvider({ id: "github-user", identity: "user", cacheEntries: 2 });
    class StatusBoom extends Error {
      override name = "StatusBoom";
    }
    const broken: CredentialProvider = {
      ...stubProvider(),
      status: () => {
        throw new StatusBoom(`leak ${SECRET_TOKEN}`);
      },
      cacheEntries: () => 5,
    };
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([broken, healthy]) });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers[0]).toEqual({
      provider: "github-app",
      state: "degraded",
      login: null,
      credential_expires_at: null,
      expiry_warning: false,
      last_error: "StatusBoom",
    });
    expect(body.providers[1].state).toBe("ok");
    expect(body.cache).toEqual({ entries: 2 });
    expect(res.body).not.toContain(SECRET_TOKEN);
  });

  it("reports a provider whose cacheEntries() throws as degraded with 0 entries", async () => {
    const broken: CredentialProvider = {
      ...stubProvider(),
      cacheEntries: () => {
        throw new TypeError("cache broke");
      },
    };
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([broken]) });
    const res = await app.inject({ method: "GET", url: "/status" });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.providers[0]).toMatchObject({
      provider: "github-app",
      state: "degraded",
      login: "march-bot[bot]",
      last_error: "TypeError",
    });
    expect(body.cache).toEqual({ entries: 0 });
  });

  it("issues an entitlement through the registered provider", async () => {
    const provider = stubProvider();
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
    const res = await postToken({
      identity: "app",
      repo: "acme/widgets",
      access: "write",
      refresh: true,
      subject: "spawn-1",
    }, undefined, LEGATE_AUTH);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      token: SECRET_TOKEN,
      expires_at: "2026-11-15T19:04:11Z",
      identity: "march-bot[bot]",
      commit_identity: {
        name: "march-bot[bot]",
        email: "123456+march-bot[bot]@users.noreply.github.com",
      },
      access: "write",
      repo: "acme/widgets",
    });
    expect(provider.issue).toHaveBeenCalledWith({
      repo: "acme/widgets",
      access: "write",
      refresh: true,
    });
  });

  describe("invalid_request", () => {
    const cases: Array<[string, unknown, string?]> = [
      ["malformed JSON", undefined, "{not json"],
      ["a non-object body", ["app"]],
      ["an unknown field", { identity: "app", repo: "acme/widgets", access: "read", scope: "x" }],
      ["a bad access", { identity: "app", repo: "acme/widgets", access: "admin" }],
      ["a missing access", { identity: "app", repo: "acme/widgets" }],
      ["a bad identity", { identity: "robot", repo: "acme/widgets", access: "read" }],
      ["app without repo", { identity: "app", access: "read" }],
      ["a malformed repo", { identity: "app", repo: "acme", access: "read" }],
      ["a dot-only repo owner and name", { identity: "app", repo: "../..", access: "read" }],
      ["a dot-only repo name", { identity: "app", repo: "acme/..", access: "read" }],
      ["a dot-only repo owner", { identity: "app", repo: "./x", access: "read" }],
      ["an over-long repo owner", { identity: "app", repo: `${"a".repeat(40)}/x`, access: "read" }],
      ["an over-long repo name", { identity: "app", repo: `acme/${"a".repeat(101)}`, access: "read" }],
      ["a non-boolean refresh", { identity: "app", repo: "acme/widgets", access: "read", refresh: "yes" }],
      ["a non-string subject", { identity: "app", repo: "acme/widgets", access: "read", subject: 7 }],
    ];

    for (const [label, body, raw] of cases) {
      it(`rejects ${label}`, async () => {
        const provider = stubProvider();
        app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
        const res = await postToken(body, raw);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: { code: "invalid_request", message: expect.any(String) },
        });
        expect(provider.issue).not.toHaveBeenCalled();
      });
    }

    it("rejects an empty body", async () => {
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
      const res = await app.inject({
        method: "POST",
        url: "/v1/github/token",
        headers: { authorization: AUTH },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    });
  });

  it("returns provider_unconfigured for an unconfigured app provider and stays healthy", async () => {
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([unconfiguredAppProvider()]) });
    const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({
      error: { code: "provider_unconfigured", message: expect.any(String) },
    });
    const health = await app.inject({ method: "GET", url: "/healthz" });
    expect(health.statusCode).toBe(200);
    expect(health.json()).toEqual({ status: "ok" });
  });

  it("returns provider_unconfigured when no provider is registered for the identity", async () => {
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
    const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
  });

  it("never serves a user request with the app provider (FR-009)", async () => {
    const appProvider = stubProvider();
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([appProvider]) });
    const res = await postToken({ identity: "user", access: "read" }, undefined, LEGATE_AUTH);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
    expect(appProvider.issue).not.toHaveBeenCalled();
  });

  it("returns repo null for a user entitlement", async () => {
    const userProvider = stubProvider({
      id: "github-user",
      identity: "user",
      issue: async () => ({
        token: SECRET_TOKEN,
        expiresAt: null,
        identity: "octocat",
        commitIdentity: null,
        cache: "n/a",
      }),
    });
    const appProvider = stubProvider();
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([appProvider, userProvider]) });
    const res = await postToken({ identity: "user", repo: "acme/widgets", access: "read" }, undefined, LEGATE_AUTH);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ identity: "octocat", repo: null, commit_identity: null });
    expect(appProvider.issue).not.toHaveBeenCalled();
  });

  it("refuses to register two providers for the same identity", () => {
    expect(() =>
      createProviderRegistry([stubProvider(), stubProvider({ id: "github-user" })]),
    ).toThrow(/identity/);
  });

  describe("typed error mapping", () => {
    const cases: Array<[TesseraError, number, string]> = [
      [new RepoNotInstalledError("not installed"), 422, "repo_not_installed"],
      [new ProviderUnconfiguredError("unconfigured"), 503, "provider_unconfigured"],
      [new CredentialInvalidError("rejected"), 503, "credential_invalid"],
      [new ProviderUnavailableError("down", 42), 503, "provider_unavailable"],
      [new MintFailedError("failed"), 502, "mint_failed"],
    ];

    for (const [error, status, code] of cases) {
      it(`maps ${code} to ${status}`, async () => {
        app = buildTesseraServer({
          clients: CLIENTS, policy: POLICY,
          registry: createProviderRegistry([
            stubProvider({
              issue: async () => {
                throw error;
              },
            }),
          ]),
        });
        const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
        expect(res.statusCode).toBe(status);
        expect(res.json()).toEqual({ error: { code, message: error.message } });
        if (code === "provider_unavailable") {
          expect(res.headers["retry-after"]).toBe("42");
        } else {
          expect(res.headers["retry-after"]).toBeUndefined();
        }
      });
    }

    it("maps a non-Tessera error carrying a 4xx statusCode to 500 internal", async () => {
      app = buildTesseraServer({
        clients: CLIENTS, policy: POLICY,
        registry: createProviderRegistry([
          stubProvider({
            issue: async () => {
              throw Object.assign(new Error("upstream said 404"), { statusCode: 404 });
            },
          }),
        ]),
      });
      const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: { code: "internal", message: "Internal server error." },
      });
    });

    it("maps a non-Fastify error with an FST-like status but no FST code to 500", async () => {
      app = buildTesseraServer({
        clients: CLIENTS, policy: POLICY,
        registry: createProviderRegistry([
          stubProvider({
            issue: async () => {
              throw Object.assign(new Error("bad"), { statusCode: 400, code: "ECONNRESET" });
            },
          }),
        ]),
      });
      const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
      expect(res.statusCode).toBe(500);
      expect(res.json().error.code).toBe("internal");
    });

    it("maps an unexpected provider failure to 500 internal without echoing it", async () => {
      app = buildTesseraServer({
        clients: CLIENTS, policy: POLICY,
        registry: createProviderRegistry([
          stubProvider({
            issue: async () => {
              throw new Error(`boom ${SECRET_TOKEN}`);
            },
          }),
        ]),
      });
      const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
      expect(res.statusCode).toBe(500);
      expect(res.json()).toEqual({
        error: { code: "internal", message: "Internal server error." },
      });
      expect(res.body).not.toContain(SECRET_TOKEN);
    });
  });

  it("keeps tokens and request/response bodies out of logs and /status", async () => {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    const logger = pino({ level: "trace" }, stream);
    app = buildTesseraServer({
      clients: CLIENTS, policy: POLICY,
      registry: createProviderRegistry([
        stubProvider(),
        stubProvider({
          id: "github-user",
          identity: "user",
          issue: async () => {
            throw new Error(`leaky ${SECRET_TOKEN}`);
          },
        }),
      ]),
      logger,
    });

    const ok = await postToken({
      identity: "app",
      repo: "acme/widgets",
      access: "write",
      subject: "subject-do-not-log",
    }, undefined, LEGATE_AUTH);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBe(SECRET_TOKEN);
    const failed = await postToken({ identity: "user", access: "read" }, undefined, LEGATE_AUTH);
    expect(failed.statusCode).toBe(500);
    const status = await app.inject({ method: "GET", url: "/status" });

    expect(status.body).not.toContain(SECRET_TOKEN);
    const logs = chunks.join("");
    expect(logs).toContain("tessera request handled");
    expect(logs).not.toContain(SECRET_TOKEN);
    // Only the audit event echoes the subject and the submitted repository (FR-015, FR-034).
    const nonAudit = logs.split("\n").filter((line) => !line.includes('"msg":"tessera.audit"'));
    expect(nonAudit.join("\n")).not.toContain("subject-do-not-log");
    expect(nonAudit.join("\n")).not.toContain("acme/widgets");
  });

  describe("client authentication (AS 2.1)", () => {
    const UNAUTHORIZED = {
      error: { code: "unauthorized", message: UNAUTHORIZED_MESSAGE },
    };
    const VALID_BODY = JSON.stringify({ identity: "app", repo: "acme/widgets", access: "read" });

    function inject(
      url: string,
      authorization: string | undefined,
      payload: string = VALID_BODY,
      method: "GET" | "POST" = "POST",
    ) {
      if (!app) throw new Error("app not built");
      return app.inject({
        method,
        url,
        headers: {
          "content-type": "application/json",
          ...(authorization === undefined ? {} : { authorization }),
        },
        ...(method === "POST" ? { payload } : {}),
      });
    }

    function expectUnauthorized(res: LightMyRequestResponse): void {
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(UNAUTHORIZED);
      expect(res.headers["www-authenticate"]).toBeUndefined();
    }

    const rejected: Array<[string, string | undefined]> = [
      ["no Authorization header", undefined],
      ["a non-Bearer scheme", `Basic ${CLIENT_KEY}`],
      ["a bare key with no scheme", CLIENT_KEY],
      ["an empty bearer token", "Bearer "],
      ["a bearer scheme with no token", "Bearer"],
      ["two bearer tokens", `Bearer ${CLIENT_KEY} ${CLIENT_KEY}`],
      ["an unknown key", "Bearer not-a-registered-key"],
      ["an over-long unknown key", `Bearer ${"k".repeat(10_000)}`],
      ["the registered hash presented as the key", `Bearer ${CLIENT_KEY_SHA256}`],
    ];

    for (const [label, authorization] of rejected) {
      it(`rejects ${label} with the fixed unauthorized response and reaches no provider`, async () => {
        const provider = stubProvider();
        app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
        expectUnauthorized(await inject("/v1/github/token", authorization));
        expect(provider.issue).not.toHaveBeenCalled();
      });
    }

    it("accepts the bearer scheme case-insensitively", async () => {
      const provider = stubProvider();
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
      const res = await inject("/v1/github/token", `bearer ${CLIENT_KEY}`);
      expect(res.statusCode).toBe(200);
      expect(provider.issue).toHaveBeenCalledTimes(1);
    });

    it("authenticates before body validation", async () => {
      const provider = stubProvider();
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
      expectUnauthorized(await inject("/v1/github/token", "Bearer unknown", "{not json"));
      expectUnauthorized(await inject("/v1/github/token", undefined, JSON.stringify({ scope: "x" })));
      const valid = await inject("/v1/github/token", AUTH, "{not json");
      expect(valid.statusCode).toBe(400);
      expect(valid.json().error.code).toBe("invalid_request");
      expect(provider.issue).not.toHaveBeenCalled();
    });

    it("rejects an unmatched /v1 path as unauthorized, and 404s it only with a valid key", async () => {
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([stubProvider()]) });
      expectUnauthorized(await inject("/v1/nope", undefined));
      expectUnauthorized(await inject("/v1", undefined, VALID_BODY, "GET"));
      expectUnauthorized(await inject("/v1/nope?x=1", "Bearer unknown"));
      const known = await inject("/v1/nope", AUTH);
      expect(known.statusCode).toBe(404);
      expect(known.json().error.code).toBe("invalid_request");
    });

    it("cannot reach a /v1 route through a percent-encoded path without a key", async () => {
      const provider = stubProvider();
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
      const res = await inject("/%761/github/token", undefined);
      expect(res.statusCode).not.toBe(200);
      expect(provider.issue).not.toHaveBeenCalled();
    });

    it("leaves /healthz and /status open", async () => {
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([stubProvider()]) });
      const health = await inject("/healthz", undefined, VALID_BODY, "GET");
      expect(health.statusCode).toBe(200);
      const status = await inject("/status", "Bearer unknown", VALID_BODY, "GET");
      expect(status.statusCode).toBe(200);
    });

    it("exposes the authenticated client name to the route, never in the response", async () => {
      const provider = stubProvider();
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([provider]) });
      const seen: Array<string | undefined> = [];
      app.get("/v1/test/caller", async (request) => {
        seen.push(request.tesseraClient);
        return { ok: true };
      });
      app.get("/test/open", async (request) => {
        seen.push(request.tesseraClient);
        return { ok: true };
      });
      await inject("/v1/test/caller", AUTH, VALID_BODY, "GET");
      await inject("/v1/test/caller", `Bearer ${OTHER_CLIENT_KEY}`, VALID_BODY, "GET");
      await inject("/test/open", AUTH, VALID_BODY, "GET");
      expect(seen).toEqual(["herald", "legate", undefined]);

      const res = await inject("/v1/github/token", AUTH);
      expect(res.statusCode).toBe(200);
      expect(res.body).not.toContain("herald");
      expect(JSON.stringify(res.headers)).not.toContain("herald");
    });

    it("keeps keys, hashes and the Authorization header out of logs, /status and error bodies", async () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
      app = buildTesseraServer({
        clients: CLIENTS, policy: POLICY,
        registry: createProviderRegistry([stubProvider()]),
        logger: pino({ level: "trace" }, stream),
      });
      const ok = await inject("/v1/github/token", AUTH);
      const bad = await inject("/v1/github/token", "Bearer unknown-key-do-not-log");
      const invalid = await inject("/v1/github/token", AUTH, "{not json");
      const status = await inject("/status", AUTH, VALID_BODY, "GET");
      expect(ok.statusCode).toBe(200);
      expectUnauthorized(bad);

      const logs = chunks.join("");
      expect(logs).toContain('"tessera.client":"herald"');
      for (const text of [logs, bad.body, invalid.body, status.body]) {
        expect(text).not.toContain(CLIENT_KEY);
        expect(text).not.toContain(CLIENT_KEY_SHA256);
        expect(text).not.toContain("unknown-key-do-not-log");
        expect(text.toLowerCase()).not.toContain("authorization");
        expect(text.toLowerCase()).not.toContain("bearer");
      }
    });
  });

  describe("policy authorization (AS 2.2-2.5, FR-015)", () => {
    type Body = Record<string, unknown>;
    const denied = (dimension: PolicyDimension) => ({
      error: { code: "policy_denied", message: POLICY_DENIED_MESSAGES[dimension] },
    });

    /** Both providers registered, so only the policy can stop a request. */
    function buildWithProviders() {
      const appProvider = stubProvider();
      const userProvider = stubProvider({ id: "github-user", identity: "user" });
      app = buildTesseraServer({
        clients: CLIENTS,
        policy: POLICY,
        registry: createProviderRegistry([appProvider, userProvider]),
      });
      return { appProvider, userProvider };
    }

    async function expectDenied(
      body: Body,
      authorization: string,
      dimension: PolicyDimension,
    ): Promise<LightMyRequestResponse> {
      const res = await postToken(body, undefined, authorization);
      expect(res.statusCode).toBe(403);
      expect(res.json()).toEqual(denied(dimension));
      return res;
    }

    /** Each outcome must be identical with subject absent, present, or changed. */
    const subjects: ReadonlyArray<Body> = [{}, { subject: "spawn-a" }, { subject: "legate" }, { subject: "" }];

    const deniedCases: Array<[string, Body, string, PolicyDimension]> = [
      ["herald app/write above its read ceiling (AS 2.2)", { identity: "app", repo: "acme/widgets", access: "write" }, AUTH, "access"],
      ["herald on a repository outside its allowlist (AS 2.3)", { identity: "app", repo: "other/widgets", access: "read" }, AUTH, "repository"],
      ["herald on a look-alike owner acme-evil", { identity: "app", repo: "acme-evil/widgets", access: "read" }, AUTH, "repository"],
      ["herald on a look-alike owner xacme", { identity: "app", repo: "xacme/widgets", access: "read" }, AUTH, "repository"],
      ["legate on an exact-entry miss", { identity: "app", repo: "acme/gadgets", access: "read" }, LEGATE_AUTH, "repository"],
      ["herald requesting user (AS 2.4)", { identity: "user", access: "read" }, AUTH, "identity"],
      ["herald requesting user with a repo", { identity: "user", repo: "acme/widgets", access: "read" }, AUTH, "identity"],
      ["brood (no rule) requesting app (AS 2.5)", { identity: "app", repo: "acme/widgets", access: "read" }, RULELESS_AUTH, "identity"],
      ["brood (no rule) requesting app write", { identity: "app", repo: "octo/x", access: "write" }, RULELESS_AUTH, "identity"],
      ["brood (no rule) requesting user", { identity: "user", access: "read" }, RULELESS_AUTH, "identity"],
    ];

    for (const [label, body, authorization, dimension] of deniedCases) {
      it(`denies ${label} as ${dimension}, reaching no provider, whatever the subject`, async () => {
        const { appProvider, userProvider } = buildWithProviders();
        for (const subject of subjects) {
          await expectDenied({ ...body, ...subject }, authorization, dimension);
        }
        expect(appProvider.issue).not.toHaveBeenCalled();
        expect(userProvider.issue).not.toHaveBeenCalled();
      });
    }

    const allowedCases: Array<[string, Body, string, "app" | "user"]> = [
      ["herald app/read inside acme/*", { identity: "app", repo: "acme/widgets", access: "read" }, AUTH, "app"],
      ["herald app/read on any acme repo, ignoring case", { identity: "app", repo: "ACME/Some-Other.repo", access: "read" }, AUTH, "app"],
      ["legate app/write on an exact entry, ignoring case", { identity: "app", repo: "Acme/Widgets", access: "write" }, LEGATE_AUTH, "app"],
      ["legate app/write inside octo/*", { identity: "app", repo: "octo/anything", access: "write" }, LEGATE_AUTH, "app"],
      ["legate user/write", { identity: "user", access: "write" }, LEGATE_AUTH, "user"],
      ["legate user with a repo outside its allowlist (SD-016)", { identity: "user", repo: "other/widgets", access: "write" }, LEGATE_AUTH, "user"],
    ];

    for (const [label, body, authorization, identity] of allowedCases) {
      it(`allows ${label}, whatever the subject`, async () => {
        const { appProvider, userProvider } = buildWithProviders();
        for (const subject of subjects) {
          const res = await postToken({ ...body, ...subject }, undefined, authorization);
          expect(res.statusCode).toBe(200);
        }
        const served = identity === "app" ? appProvider : userProvider;
        const other = identity === "app" ? userProvider : appProvider;
        expect(served.issue).toHaveBeenCalledTimes(subjects.length);
        expect(other.issue).not.toHaveBeenCalled();
      });
    }

    it("returns 403, never provider_unconfigured, for a denial with no providers registered", async () => {
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
      for (const [, body, authorization, dimension] of deniedCases) {
        await expectDenied(body, authorization, dimension);
      }
    });

    it("still returns provider_unconfigured for an allowed request with no providers registered", async () => {
      app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
      const allowedApp = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
      expect(allowedApp.statusCode).toBe(503);
      expect(allowedApp.json().error.code).toBe("provider_unconfigured");
      // legate's user grant passes the policy; no user provider exists yet.
      const allowedUser = await postToken({ identity: "user", access: "write" }, undefined, LEGATE_AUTH);
      expect(allowedUser.statusCode).toBe(503);
      expect(allowedUser.json().error.code).toBe("provider_unconfigured");
    });

    it("checks the key, then the body, then the policy", async () => {
      const { appProvider } = buildWithProviders();
      const deniedBody = { identity: "app", repo: "other/widgets", access: "write" };
      const unknownKey = await postToken(deniedBody, undefined, "Bearer not-a-registered-key");
      expect(unknownKey.statusCode).toBe(401);
      expect(unknownKey.json().error.code).toBe("unauthorized");
      const noRuleBadBody = await postToken(undefined, "{not json", RULELESS_AUTH);
      expect(noRuleBadBody.statusCode).toBe(400);
      expect(noRuleBadBody.json().error.code).toBe("invalid_request");
      const invalidForHerald = await postToken({ identity: "user", access: "admin" });
      expect(invalidForHerald.statusCode).toBe(400);
      expect(invalidForHerald.json().error.code).toBe("invalid_request");
      await expectDenied(deniedBody, AUTH, "repository");
      expect(appProvider.issue).not.toHaveBeenCalled();
    });

    it("keeps the allowlist, the submitted repo and the subject out of 403 bodies and logs", async () => {
      const stream = new PassThrough();
      const chunks: string[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
      app = buildTesseraServer({
        clients: CLIENTS,
        policy: POLICY,
        registry: createProviderRegistry([stubProvider()]),
        logger: pino({ level: "trace" }, stream),
      });
      const submittedRepos = ["submitted-owner/submitted-repo", "acme/widgets", "acme/gadgets"];
      const bodies: string[] = [];
      for (const [body, authorization] of [
        [{ identity: "app", repo: submittedRepos[0], access: "read" }, AUTH],
        [{ identity: "app", repo: submittedRepos[1], access: "write" }, AUTH],
        [{ identity: "app", repo: submittedRepos[2], access: "read" }, LEGATE_AUTH],
        [{ identity: "user", repo: submittedRepos[1], access: "read" }, AUTH],
        [{ identity: "app", repo: submittedRepos[1], access: "read" }, RULELESS_AUTH],
      ] as const) {
        const res = await postToken({ ...body, subject: "subject-do-not-log" }, undefined, authorization);
        expect(res.statusCode).toBe(403);
        bodies.push(res.body);
      }
      const logs = chunks.join("");
      expect(logs).toContain("tessera request handled");
      expect(logs).toContain('"tessera.status_class":"4xx"');
      // The audit event echoes the submitted repository and subject (FR-015,
      // FR-034); every other line, and every body, carries neither.
      const lines = logs.split("\n");
      const auditLogs = lines.filter((line) => line.includes('"msg":"tessera.audit"')).join("\n");
      const otherLogs = lines.filter((line) => !line.includes('"msg":"tessera.audit"')).join("\n");
      for (const text of [otherLogs, ...bodies]) {
        for (const leaked of [...ALLOWLIST_ENTRIES, ...submittedRepos, "submitted-owner", "subject-do-not-log"]) {
          expect(text).not.toContain(leaked);
        }
      }
      // The audit never names an allowlist entry the request did not submit.
      for (const entry of ALLOWLIST_ENTRIES.filter((e) => !submittedRepos.includes(e))) {
        expect(auditLogs).not.toContain(entry);
      }
    });
  });
});

/**
 * The HTTP contract driven through the real github-app provider against the
 * in-process fake GitHub API (FR-042): the success shape and every US1 error
 * code, `/status` provider state, and no token or assertion in logs.
 */
describe("tessera server with the github-app provider", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const otherKey = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
  const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const KEY_FILE = "/virtual/tessera-app.pem";

  let app: FastifyInstance | undefined;
  let fake: FakeGitHub | undefined;

  afterEach(async () => {
    if (app) await app.close();
    await fake?.close();
    app = undefined;
    fake = undefined;
  });

  interface Harness {
    readonly fake: FakeGitHub;
    readonly app: FastifyInstance;
    readonly provider: CredentialProvider;
    readonly logs: () => string;
    readonly assertions: readonly string[];
    readonly post: (body: unknown) => Promise<LightMyRequestResponse>;
  }

  interface HarnessOptions {
    readonly fakeOptions?: FakeGitHubOptions;
    readonly timeoutMs?: number;
    /** Called after the fake starts and before the provider starts. */
    readonly beforeStart?: (fake: FakeGitHub) => void | Promise<void>;
    /** Shared wall clock for the fake and the provider's token cache. */
    readonly now?: () => number;
  }

  async function harness(options: HarnessOptions = {}): Promise<Harness> {
    fake = await startFakeGitHub({
      app: { id: 42, slug: "march-bot" },
      botUserId: 123456,
      installations: {
        acme: { id: 7, repos: ["widgets", "gadgets"] },
      },
      publicKey,
      ...(options.now === undefined ? {} : { now: options.now }),
      ...options.fakeOptions,
    });
    const assertions: string[] = [];
    const recordingFetch: typeof fetch = async (input, init) => {
      const auth = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (auth?.startsWith("Bearer ")) assertions.push(auth.slice("Bearer ".length));
      return fetch(input, init);
    };
    const client = new GitHubClient({
      baseUrl: fake.baseUrl,
      fetchImpl: recordingFetch,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    });
    const provider = createGitHubAppProvider({
      config: { configured: true, appId: "42", keyFile: KEY_FILE, installationId: undefined },
      client,
      ...(options.now === undefined ? {} : { now: options.now }),
      readFile: (path) => {
        if (path !== KEY_FILE) throw new Error("ENOENT");
        return PEM;
      },
    });
    await options.beforeStart?.(fake);
    await provider.start();

    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    app = buildTesseraServer({
      clients: CLIENTS, policy: POLICY,
      registry: createProviderRegistry([provider]),
      logger: pino({ level: "trace" }, stream),
    });
    const built = app;
    return {
      fake,
      app: built,
      provider,
      logs: () => chunks.join(""),
      assertions,
      // legate: app write on acme/widgets, acme/secret-repo and octo/*.
      post: (body) =>
        built.inject({
          method: "POST",
          url: "/v1/github/token",
          headers: { "content-type": "application/json", authorization: LEGATE_AUTH },
          payload: JSON.stringify(body),
        }),
    };
  }

  const mintBodies = (f: FakeGitHub) =>
    f.calls.filter((call) => call.endpoint === "token").map((call) => call.body);

  /** No token minted by the fake and no app assertion reaches the logs. */
  function expectNoSecretsLogged(h: Harness, tokens: readonly string[]): void {
    const logs = h.logs();
    expect(logs).toContain("tessera request handled");
    for (const token of tokens) expect(logs).not.toContain(token);
    expect(h.assertions.length).toBeGreaterThan(0);
    for (const assertion of h.assertions) expect(logs).not.toContain(assertion);
  }

  for (const access of ["read", "write"] as const) {
    it(`mints a downscoped ${access} token for exactly one repository`, async () => {
      const h = await harness();
      const res = await h.post({ identity: "app", repo: "acme/widgets", access });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toEqual({
        token: expect.stringMatching(/^ghs_fake\d{4}$/),
        expires_at: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        identity: "march-bot[bot]",
        commit_identity: {
          name: "march-bot[bot]",
          email: "123456+march-bot[bot]@users.noreply.github.com",
        },
        access,
        repo: "acme/widgets",
      });
      expect(mintBodies(h.fake)).toEqual([
        { repositories: ["widgets"], permissions: { ...ACCESS_PROFILES[access] } },
      ]);

      const status = await h.app.inject({ method: "GET", url: "/status" });
      expect(status.statusCode).toBe(200);
      expect(status.json().providers).toEqual([
        {
          provider: "github-app",
          state: "ok",
          login: "march-bot[bot]",
          credential_expires_at: null,
          expiry_warning: false,
          last_error: null,
        },
      ]);
      expect(status.body).not.toContain(body.token);
      for (const assertion of h.assertions) expect(status.body).not.toContain(assertion);
      expectNoSecretsLogged(h, [body.token]);
    });
  }

  it("reuses a cached token for a repeat request, re-mints on refresh, and counts entries on /status", async () => {
    const h = await harness();
    const first = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    const second = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    expect(h.fake.issuedCount()).toBe(1);

    const refreshed = await h.post({ identity: "app", repo: "acme/widgets", access: "read", refresh: true });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().token).not.toBe(first.json().token);
    expect(h.fake.issuedCount()).toBe(2);

    await h.post({ identity: "app", repo: "acme/widgets", access: "write" });
    const status = await h.app.inject({ method: "GET", url: "/status" });
    expect(status.json().cache).toEqual({ entries: 2 });
    expect(status.body).not.toContain(first.json().token);
  });

  it("returns 422 repo_not_installed for an uninstalled owner without minting", async () => {
    const h = await harness();
    // octo/* is allowed by policy, but the app has no installation on octo.
    const res = await h.post({ identity: "app", repo: "octo/widgets", access: "read" });
    expect(res.statusCode).toBe(422);
    expect(res.json()).toEqual({ error: { code: "repo_not_installed", message: expect.any(String) } });
    expect(h.fake.mintCount()).toBe(0);
  });

  it("returns 422 repo_not_installed when the installation excludes the repository", async () => {
    const h = await harness();
    const res = await h.post({ identity: "app", repo: "acme/secret-repo", access: "write" });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.code).toBe("repo_not_installed");
    // Scope is never widened: the one refused mint is the only one.
    expect(mintBodies(h.fake)).toEqual([
      { repositories: ["secret-repo"], permissions: { ...ACCESS_PROFILES.write } },
    ]);
  });

  it("returns 503 provider_unavailable with Retry-After when GitHub hangs", async () => {
    const h = await harness({ timeoutMs: 100 });
    h.fake.fail("token", { hang: true });
    const started = Date.now();
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(res.headers["retry-after"]).toBe("30");
    const status = (await h.app.inject({ method: "GET", url: "/status" })).json();
    expect(status.providers[0]).toMatchObject({ state: "degraded", last_error: "provider_unavailable" });
  });

  it("serves an unexpired cached token through a GitHub outage, then mints anew on recovery", async () => {
    let t = Date.parse("2026-11-15T12:00:00Z");
    const h = await harness({ now: () => t, timeoutMs: 100 });
    const first = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(first.statusCode).toBe(200);

    t += 55 * 60 * 1000; // inside the ten-minute re-mint window, still unexpired
    h.fake.fail("token", { status: 503, retryAfter: "7" });
    const served = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(served.statusCode).toBe(200);
    expect(served.json()).toEqual(first.json());
    expect(served.headers["retry-after"]).toBeUndefined();
    const degraded = (await h.app.inject({ method: "GET", url: "/status" })).json();
    expect(degraded.providers[0]).toMatchObject({ state: "degraded", last_error: "provider_unavailable" });
    expect(degraded.cache).toEqual({ entries: 1 });

    // A refresh has nothing to fall back to.
    const refreshed = await h.post({ identity: "app", repo: "acme/widgets", access: "read", refresh: true });
    expect(refreshed.statusCode).toBe(503);
    expect(refreshed.json().error.code).toBe("provider_unavailable");

    h.fake.fail("token", null);
    const recovered = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json().token).not.toBe(first.json().token);
    const ok = (await h.app.inject({ method: "GET", url: "/status" })).json();
    expect(ok.providers[0]).toMatchObject({ state: "ok", last_error: null });
  });

  it("returns 503 provider_unavailable through an outage once the cached token has expired", async () => {
    let t = Date.parse("2026-11-15T12:00:00Z");
    const h = await harness({ now: () => t, timeoutMs: 100 });
    await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    t += 61 * 60 * 1000;
    h.fake.fail("token", { hang: true });
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(res.headers["retry-after"]).toBe("30");
  });

  it("returns 503 provider_unavailable forwarding Retry-After on a GitHub 5xx", async () => {
    const h = await harness();
    h.fake.fail("token", { status: 503, retryAfter: "7" });
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unavailable");
    expect(res.headers["retry-after"]).toBe("7");
  });

  it("serves despite a GitHub outage at start, refusing mints until the identity is known", async () => {
    const h = await harness({ beforeStart: (f) => f.fail("app", { status: 502 }) });
    const status = (await h.app.inject({ method: "GET", url: "/status" })).json();
    expect(status.providers[0]).toMatchObject({ state: "degraded", login: null });
    const refused = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(refused.statusCode).toBe(503);
    expect(refused.json().error.code).toBe("provider_unavailable");
    expect(refused.headers["retry-after"]).toBeDefined();
    expect(h.fake.mintCount()).toBe(0);

    h.fake.fail("app", null);
    const ok = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(ok.statusCode).toBe(200);
    const recovered = (await h.app.inject({ method: "GET", url: "/status" })).json();
    expect(recovered.providers[0]).toMatchObject({ state: "ok", login: "march-bot[bot]" });
  });

  it("returns 503 credential_invalid when GitHub rejects the app credential", async () => {
    const h = await harness({ fakeOptions: { publicKey: otherKey } });
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: { code: "credential_invalid", message: expect.any(String) } });
    expect(res.headers["retry-after"]).toBeUndefined();
    const status = await h.app.inject({ method: "GET", url: "/status" });
    expect(status.json().providers[0]).toMatchObject({
      state: "invalid",
      login: null,
      last_error: "credential_invalid",
    });
    expect(h.fake.mintCount()).toBe(0);
    for (const assertion of h.assertions) {
      expect(status.body).not.toContain(assertion);
      expect(h.logs()).not.toContain(assertion);
    }
  });

  it("returns 502 mint_failed for any other GitHub refusal", async () => {
    const h = await harness();
    h.fake.fail("token", { status: 403 });
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(502);
    expect(res.json()).toEqual({ error: { code: "mint_failed", message: expect.any(String) } });
  });

  it("returns 400 invalid_request without reaching GitHub", async () => {
    const h = await harness();
    h.fake.reset();
    const res = await h.post({ identity: "app", repo: "acme/widgets", access: "admin" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("invalid_request");
    expect(h.fake.calls).toEqual([]);
  });

  it("returns 503 provider_unconfigured for user requests; the app provider never serves them", async () => {
    const h = await harness();
    h.fake.reset();
    const res = await h.post({ identity: "user", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
    expect(h.fake.calls).toEqual([]);
  });

  it("returns 503 provider_unconfigured for app requests when no app provider is registered", async () => {
    app = buildTesseraServer({ clients: CLIENTS, policy: POLICY, registry: createProviderRegistry([]) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: { "content-type": "application/json", authorization: AUTH },
      payload: JSON.stringify({ identity: "app", repo: "acme/widgets", access: "read" }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
  });
});

/**
 * One `tessera.audit` event per token request (AS 8.1, FR-015, FR-034),
 * whatever the outcome, and none for any other route.
 */
describe("tessera.audit events", () => {
  let app: FastifyInstance | undefined;
  let chunks: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    chunks = [];
  });

  function build(providers: readonly CredentialProvider[]): FastifyInstance {
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    app = buildTesseraServer({
      clients: CLIENTS,
      policy: POLICY,
      registry: createProviderRegistry(providers),
      logger: pino({ level: "trace" }, stream),
    });
    return app;
  }

  function lines(): Array<Record<string, unknown>> {
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  function auditLines(): Array<Record<string, unknown>> {
    return lines().filter((line) => line.msg === "tessera.audit");
  }

  /** The single audit record logged so far; fails unless there is exactly one. */
  function onlyAudit(): Record<string, unknown> {
    const audits = auditLines();
    expect(audits).toHaveLength(1);
    const line = audits[0]!;
    expect(line.level).toBe(30);
    return line.audit as Record<string, unknown>;
  }

  /** `authorization: null` sends no Authorization header. */
  function post(
    body: unknown,
    authorization: string | null = AUTH,
    raw?: string,
  ): Promise<LightMyRequestResponse> {
    if (!app) throw new Error("app not built");
    return app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      payload: raw ?? JSON.stringify(body),
    });
  }

  const UNRESOLVED = {
    identity: null,
    provider: null,
    repo: null,
    access: null,
    cache: "n/a",
    expires_at: null,
    subject: null,
  };

  it("records an issued cache miss with the subject echoed", async () => {
    build([stubProvider()]);
    const res = await post({ identity: "app", repo: "acme/widgets", access: "read", subject: "spawn-a" });
    expect(res.statusCode).toBe(200);
    expect(onlyAudit()).toEqual({
      caller: "herald",
      identity: "app",
      provider: "github-app",
      repo: "acme/widgets",
      access: "read",
      outcome: "issued",
      reason: null,
      cache: "miss",
      expires_at: "2026-11-15T19:04:11Z",
      subject: "spawn-a",
    });
  });

  it("records an issued cache hit with no subject as null", async () => {
    build([
      stubProvider({
        issue: async () => ({
          token: SECRET_TOKEN,
          expiresAt: "2026-11-15T20:00:00Z",
          identity: "march-bot[bot]",
          commitIdentity: null,
          cache: "hit",
        }),
      }),
    ]);
    await post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(onlyAudit()).toMatchObject({
      outcome: "issued",
      cache: "hit",
      expires_at: "2026-11-15T20:00:00Z",
      subject: null,
    });
  });

  it("records a user issuance under the user provider", async () => {
    build([stubProvider(), stubProvider({ id: "github-user", identity: "user" })]);
    await post({ identity: "user", access: "write" }, LEGATE_AUTH);
    expect(onlyAudit()).toMatchObject({
      caller: "legate",
      identity: "user",
      provider: "github-user",
      repo: null,
      access: "write",
      outcome: "issued",
    });
  });

  const unauthenticated: Array<[string, string | null]> = [
    ["no key", null],
    ["an unknown key", "Bearer not-a-registered-key"],
  ];
  for (const [label, authorization] of unauthenticated) {
    it(`records ${label} as caller unknown, denied unauthorized, fields null`, async () => {
      build([stubProvider()]);
      const res = await post({ identity: "app", repo: "acme/widgets", access: "read" }, authorization);
      expect(res.statusCode).toBe(401);
      expect(onlyAudit()).toEqual({
        caller: "unknown",
        outcome: "denied",
        reason: "unauthorized",
        ...UNRESOLVED,
      });
    });
  }

  it("records malformed JSON as denied invalid_request with the caller known", async () => {
    build([stubProvider()]);
    const res = await post(undefined, AUTH, "{not json");
    expect(res.statusCode).toBe(400);
    expect(onlyAudit()).toEqual({
      caller: "herald",
      outcome: "denied",
      reason: "invalid_request",
      ...UNRESOLVED,
    });
  });

  it("records an invalid field as denied invalid_request with nothing resolved", async () => {
    build([stubProvider()]);
    const res = await post({ identity: "app", repo: "acme/widgets", access: "admin", subject: "s" });
    expect(res.statusCode).toBe(400);
    expect(onlyAudit()).toEqual({
      caller: "herald",
      outcome: "denied",
      reason: "invalid_request",
      ...UNRESOLVED,
    });
  });

  const policyDenials: Array<[PolicyDimension, Record<string, unknown>, string]> = [
    ["access", { identity: "app", repo: "acme/widgets", access: "write" }, AUTH],
    ["repository", { identity: "app", repo: "other/widgets", access: "read" }, AUTH],
    ["identity", { identity: "user", access: "read" }, AUTH],
  ];
  for (const [dimension, body, authorization] of policyDenials) {
    it(`records a ${dimension} policy denial with the request fields and no provider`, async () => {
      build([stubProvider(), stubProvider({ id: "github-user", identity: "user" })]);
      const res = await post({ ...body, subject: "spawn-b" }, authorization);
      expect(res.statusCode).toBe(403);
      expect(onlyAudit()).toEqual({
        caller: "herald",
        identity: body.identity,
        provider: null,
        repo: body.repo ?? null,
        access: body.access,
        outcome: "denied",
        reason: "policy_denied",
        cache: "n/a",
        expires_at: null,
        subject: "spawn-b",
      });
    });
  }

  it("records repo_not_installed (422) as denied with the provider reached", async () => {
    build([
      stubProvider({
        issue: async () => {
          throw new RepoNotInstalledError("not installed");
        },
      }),
    ]);
    const res = await post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(422);
    expect(onlyAudit()).toMatchObject({
      provider: "github-app",
      outcome: "denied",
      reason: "repo_not_installed",
      cache: "n/a",
      expires_at: null,
    });
  });

  it("records provider_unconfigured with no provider for the identity as failed, provider null", async () => {
    build([]);
    const res = await post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(onlyAudit()).toMatchObject({
      identity: "app",
      provider: null,
      outcome: "failed",
      reason: "provider_unconfigured",
    });
  });

  const providerFailures: Array<[TesseraError, number, string]> = [
    [new ProviderUnconfiguredError("unconfigured"), 503, "provider_unconfigured"],
    [new CredentialInvalidError("rejected"), 503, "credential_invalid"],
    [new ProviderUnavailableError("down", 5), 503, "provider_unavailable"],
    [new MintFailedError("failed"), 502, "mint_failed"],
  ];
  for (const [error, status, code] of providerFailures) {
    it(`records a provider ${code} (${status}) as failed`, async () => {
      build([
        stubProvider({
          issue: async () => {
            throw error;
          },
        }),
      ]);
      const res = await post({ identity: "app", repo: "acme/widgets", access: "read" });
      expect(res.statusCode).toBe(status);
      expect(onlyAudit()).toMatchObject({
        caller: "herald",
        provider: "github-app",
        outcome: "failed",
        reason: code,
        cache: "n/a",
        expires_at: null,
      });
    });
  }

  it("records an unexpected provider error as failed internal", async () => {
    build([
      stubProvider({
        issue: async () => {
          throw new Error(`boom ${SECRET_TOKEN}`);
        },
      }),
    ]);
    const res = await post({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(500);
    expect(onlyAudit()).toMatchObject({ provider: "github-app", outcome: "failed", reason: "internal" });
  });

  it("emits no audit event for any other route", async () => {
    const built = build([stubProvider()]);
    await built.inject({ method: "GET", url: "/healthz" });
    await built.inject({ method: "GET", url: "/status" });
    await built.inject({ method: "POST", url: "/v1/nope", headers: { authorization: AUTH } });
    await built.inject({ method: "POST", url: "/v1/nope" });
    await built.inject({ method: "GET", url: "/v1/github/token", headers: { authorization: AUTH } });
    await built.inject({ method: "GET", url: "/nope" });
    expect(lines().some((line) => line.msg === "tessera request handled")).toBe(true);
    expect(auditLines()).toEqual([]);
  });

  it("logs the audit event beside the request line, never a token, key, hash or header", async () => {
    build([stubProvider()]);
    await post({ identity: "app", repo: "acme/widgets", access: "read" });
    await post({ identity: "app", repo: "acme/widgets", access: "read" }, "Bearer unknown-key-do-not-log");
    await post(undefined, AUTH, "{not json");
    expect(auditLines()).toHaveLength(3);
    expect(lines().filter((line) => line.msg === "tessera request handled")).toHaveLength(3);
    for (const line of auditLines()) {
      const text = JSON.stringify(line);
      for (const leaked of [SECRET_TOKEN, CLIENT_KEY, CLIENT_KEY_SHA256, "unknown-key-do-not-log"]) {
        expect(text).not.toContain(leaked);
      }
      expect(text.toLowerCase()).not.toContain("authorization");
      expect(text.toLowerCase()).not.toContain("bearer");
    }
  });
});

/**
 * One `tessera.issue` span per token request (AS 8.1-8.3, FR-035), whose
 * trace and span ids ride on the `tessera.audit` line as correlation fields.
 */
describe("tessera.issue spans", () => {
  let app: FastifyInstance | undefined;
  let chunks: string[] = [];

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    chunks = [];
    vi.restoreAllMocks();
    initOtel({});
  });

  function captureSpans(): Span[] {
    const tracer = getActiveOtel().getTracer();
    const created: Span[] = [];
    const real = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, "startSpan").mockImplementation((...args: Parameters<typeof real>) => {
      const span = real(...args) as Span;
      created.push(span);
      return span;
    });
    return created;
  }

  function enable(): Span[] {
    initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
    return captureSpans();
  }

  function build(providers: readonly CredentialProvider[] = [stubProvider()]): FastifyInstance {
    const stream = new PassThrough();
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    app = buildTesseraServer({
      clients: CLIENTS,
      policy: POLICY,
      registry: createProviderRegistry(providers),
      logger: pino({ level: "trace" }, stream),
    });
    return app;
  }

  function auditLines(): Array<Record<string, unknown>> {
    return chunks
      .join("")
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((line) => line.msg === "tessera.audit");
  }

  function post(
    body: unknown,
    options: { authorization?: string | null; raw?: string; sliceId?: string } = {},
  ): Promise<LightMyRequestResponse> {
    if (!app) throw new Error("app not built");
    const authorization = options.authorization === undefined ? AUTH : options.authorization;
    return app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
        ...(options.sliceId === undefined ? {} : { [TESSERA_SLICE_ID_HEADER]: options.sliceId }),
      },
      payload: options.raw ?? JSON.stringify(body),
    });
  }

  const VALID = { identity: "app", repo: "acme/widgets", access: "read" };

  it("emits one span per token request, whatever the outcome, and none for other routes", async () => {
    const spans = enable();
    const built = build([
      stubProvider(),
      stubProvider({
        id: "github-user",
        identity: "user",
        issue: async () => {
          throw new MintFailedError("failed");
        },
      }),
    ]);
    const statuses = [
      (await post(VALID)).statusCode,
      (await post(VALID, { authorization: null })).statusCode,
      (await post(undefined, { raw: "{not json" })).statusCode,
      (await post({ ...VALID, access: "write" })).statusCode,
      (await post({ identity: "user", access: "write" }, { authorization: LEGATE_AUTH })).statusCode,
    ];
    expect(statuses).toEqual([200, 401, 400, 403, 502]);
    const tokenSpans = spans.filter((span) => span.name === "tessera.issue");
    expect(tokenSpans).toHaveLength(5);
    expect(tokenSpans.map((span) => span.attributes["tessera.outcome"])).toEqual([
      "issued",
      "denied",
      "denied",
      "denied",
      "failed",
    ]);
    expect(tokenSpans.map((span) => span.status.code)).toEqual([
      SpanStatusCode.UNSET,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
      SpanStatusCode.ERROR,
    ]);
    expect(tokenSpans[1]!.attributes["tessera.caller"]).toBe("unknown");
    expect(tokenSpans[0]!.attributes).toMatchObject({
      "tessera.caller": "herald",
      "tessera.identity": "app",
      "tessera.provider": "github-app",
      "tessera.access": "read",
      "tessera.cache": "miss",
    });
    for (const span of tokenSpans) {
      const text = JSON.stringify(span.attributes);
      for (const leaked of ["acme", SECRET_TOKEN, CLIENT_KEY, CLIENT_KEY_SHA256]) {
        expect(text).not.toContain(leaked);
      }
    }

    const before = spans.length;
    await built.inject({ method: "GET", url: "/healthz" });
    await built.inject({ method: "GET", url: "/status" });
    await built.inject({ method: "POST", url: "/v1/nope", headers: { authorization: AUTH } });
    await built.inject({ method: "GET", url: "/nope" });
    expect(spans.slice(before).filter((span) => span.name === "tessera.issue")).toEqual([]);
  });

  it("nests under a valid slice id and puts its ids on the audit line, outside the record", async () => {
    const spans = enable();
    build();
    await post(VALID, { sliceId: "slice-abc" });
    const span = spans.find((s) => s.name === "tessera.issue")!;
    expect(span.spanContext().traceId).toBe(traceIdForDispatch("slice-abc"));
    expect(span.parentSpanContext?.spanId).toBe(spanIdForDispatch("slice-abc"));
    expect(span.spanContext().spanId).not.toBe(spanIdForDispatch("slice-abc"));
    const [line] = auditLines();
    expect(line).toMatchObject({
      trace_id: span.spanContext().traceId,
      span_id: span.spanContext().spanId,
    });
    const audit = line!.audit as Record<string, unknown>;
    expect(audit.trace_id).toBeUndefined();
    expect(audit.span_id).toBeUndefined();
  });

  it("starts a service-local trace for an invalid slice id", async () => {
    const spans = enable();
    build();
    await post(VALID, { sliceId: "not a slice id!" });
    const span = spans.find((s) => s.name === "tessera.issue")!;
    expect(span.parentSpanContext).toBeUndefined();
  });

  it("spans the request's own duration", async () => {
    const spans = enable();
    build([
      stubProvider({
        issue: async () => {
          await new Promise((resolve) => setTimeout(resolve, 25));
          return {
            token: SECRET_TOKEN,
            expiresAt: null,
            identity: "march-bot[bot]",
            commitIdentity: null,
            cache: "miss",
          };
        },
      }),
    ]);
    await post(VALID);
    const span = spans.find((s) => s.name === "tessera.issue")!;
    expect(span.duration[0] * 1000 + span.duration[1] / 1e6).toBeGreaterThanOrEqual(20);
  });

  it("emits nothing and adds no correlation fields when telemetry is off", async () => {
    build();
    const res = await post(VALID, { sliceId: "slice-abc" });
    expect(res.statusCode).toBe(200);
    const [line] = auditLines();
    expect(line).toBeDefined();
    expect(line!.trace_id).toBeUndefined();
    expect(line!.span_id).toBeUndefined();
  });
});

/**
 * One counter increment per token request (AS 8.2, FR-036): an issued request
 * counts one issuance, a denied or failed one counts one denial with its error
 * code as the reason, never both, and no other route counts anything.
 */
describe("tessera issuance and denial counters", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    if (app) await app.close();
    app = undefined;
    vi.restoreAllMocks();
    initOtel({});
  });

  interface Counted {
    readonly issuances: ReturnType<typeof vi.fn>;
    readonly denials: ReturnType<typeof vi.fn>;
  }

  /** Enable telemetry and capture the server counters' `add` calls. */
  function enable(): Counted {
    const meter = initOtel({
      MARCH_OTEL: "1",
      MARCH_OTEL_ENDPOINT: "http://localhost:4318",
    }).getMeter();
    const counted: Counted = { issuances: vi.fn(), denials: vi.fn() };
    vi.spyOn(meter, "createCounter").mockImplementation((name: string) => {
      if (name === "march.tessera.issuances") return { add: counted.issuances } as never;
      if (name === "march.tessera.denials") return { add: counted.denials } as never;
      return { add: vi.fn() } as never;
    });
    return counted;
  }

  function build(providers: readonly CredentialProvider[] = [stubProvider()]): FastifyInstance {
    app = buildTesseraServer({
      clients: CLIENTS,
      policy: POLICY,
      registry: createProviderRegistry(providers),
    });
    return app;
  }

  function post(
    body: unknown,
    authorization: string | null = AUTH,
    raw?: string,
  ): Promise<LightMyRequestResponse> {
    if (!app) throw new Error("app not built");
    return app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: {
        "content-type": "application/json",
        ...(authorization === null ? {} : { authorization }),
      },
      payload: raw ?? JSON.stringify(body),
    });
  }

  const VALID = { identity: "app", repo: "acme/widgets", access: "read" };

  function cachedProvider(cache: "hit" | "miss"): CredentialProvider {
    return stubProvider({
      issue: async () => ({
        token: SECRET_TOKEN,
        expiresAt: "2026-11-15T20:00:00Z",
        identity: "march-bot[bot]",
        commitIdentity: null,
        cache,
      }),
    });
  }

  for (const cache of ["hit", "miss"] as const) {
    it(`counts one issuance for an issued cache ${cache} and no denial`, async () => {
      const counted = enable();
      build([cachedProvider(cache)]);
      expect((await post(VALID)).statusCode).toBe(200);
      expect(counted.issuances).toHaveBeenCalledTimes(1);
      expect(counted.issuances).toHaveBeenCalledWith(1, {
        identity: "app",
        provider: "github-app",
        access: "read",
        cache,
      });
      expect(counted.denials).not.toHaveBeenCalled();
    });
  }

  it("counts a user issuance under the user provider", async () => {
    const counted = enable();
    build([stubProvider(), stubProvider({ id: "github-user", identity: "user" })]);
    expect((await post({ identity: "user", access: "write" }, LEGATE_AUTH)).statusCode).toBe(200);
    expect(counted.issuances).toHaveBeenCalledWith(1, {
      identity: "user",
      provider: "github-user",
      access: "write",
      cache: "miss",
    });
  });

  function failing(error: Error): CredentialProvider {
    return stubProvider({
      issue: async () => {
        throw error;
      },
    });
  }

  const denials: Array<{
    label: string;
    providers: () => CredentialProvider[];
    send: () => Promise<LightMyRequestResponse>;
    status: number;
    labels: { identity: string; reason: string };
  }> = [
    {
      label: "no key",
      providers: () => [stubProvider()],
      send: () => post(VALID, null),
      status: 401,
      labels: { identity: "none", reason: "unauthorized" },
    },
    {
      label: "an unknown key",
      providers: () => [stubProvider()],
      send: () => post(VALID, "Bearer not-a-registered-key"),
      status: 401,
      labels: { identity: "none", reason: "unauthorized" },
    },
    {
      label: "malformed JSON",
      providers: () => [stubProvider()],
      send: () => post(undefined, AUTH, "{not json"),
      status: 400,
      labels: { identity: "none", reason: "invalid_request" },
    },
    {
      label: "an invalid field",
      providers: () => [stubProvider()],
      send: () => post({ ...VALID, access: "admin" }),
      status: 400,
      labels: { identity: "none", reason: "invalid_request" },
    },
    {
      label: "a policy denial",
      providers: () => [stubProvider()],
      send: () => post({ ...VALID, access: "write" }),
      status: 403,
      labels: { identity: "app", reason: "policy_denied" },
    },
    {
      label: "repo_not_installed",
      providers: () => [failing(new RepoNotInstalledError("not installed"))],
      send: () => post(VALID),
      status: 422,
      labels: { identity: "app", reason: "repo_not_installed" },
    },
    {
      label: "no provider for the identity",
      providers: () => [],
      send: () => post(VALID),
      status: 503,
      labels: { identity: "app", reason: "provider_unconfigured" },
    },
    {
      label: "credential_invalid",
      providers: () => [failing(new CredentialInvalidError("rejected"))],
      send: () => post(VALID),
      status: 503,
      labels: { identity: "app", reason: "credential_invalid" },
    },
    {
      label: "provider_unavailable",
      providers: () => [failing(new ProviderUnavailableError("down", 5))],
      send: () => post(VALID),
      status: 503,
      labels: { identity: "app", reason: "provider_unavailable" },
    },
    {
      label: "mint_failed",
      providers: () => [failing(new MintFailedError("failed"))],
      send: () => post(VALID),
      status: 502,
      labels: { identity: "app", reason: "mint_failed" },
    },
    {
      label: "an unexpected error",
      providers: () => [failing(new Error("boom"))],
      send: () => post(VALID),
      status: 500,
      labels: { identity: "app", reason: "internal" },
    },
  ];
  for (const { label, providers, send, status, labels } of denials) {
    it(`counts one denial for ${label} (${status}) with reason ${labels.reason} and no issuance`, async () => {
      const counted = enable();
      build(providers());
      expect((await send()).statusCode).toBe(status);
      expect(counted.denials).toHaveBeenCalledTimes(1);
      expect(counted.denials).toHaveBeenCalledWith(1, labels);
      expect(counted.issuances).not.toHaveBeenCalled();
    });
  }

  it("counts nothing for any other route", async () => {
    const counted = enable();
    const built = build();
    await built.inject({ method: "GET", url: "/healthz" });
    await built.inject({ method: "GET", url: "/status" });
    await built.inject({ method: "POST", url: "/v1/nope", headers: { authorization: AUTH } });
    await built.inject({ method: "POST", url: "/v1/nope" });
    await built.inject({ method: "GET", url: "/v1/github/token", headers: { authorization: AUTH } });
    await built.inject({ method: "GET", url: "/nope" });
    expect(counted.issuances).not.toHaveBeenCalled();
    expect(counted.denials).not.toHaveBeenCalled();
  });

  it("never carries a repository, client name, key or token in a label", async () => {
    const counted = enable();
    build();
    await post(VALID);
    await post({ ...VALID, access: "write" });
    await post(VALID, "Bearer not-a-registered-key");
    const labels = JSON.stringify([...counted.issuances.mock.calls, ...counted.denials.mock.calls]);
    for (const leaked of ["acme", "herald", SECRET_TOKEN, CLIENT_KEY, CLIENT_KEY_SHA256, "not-a-registered-key"]) {
      expect(labels).not.toContain(leaked);
    }
  });
});

/**
 * No credential reaches any output (AS 8.5, FR-038). The real server and the
 * real github-app provider run against the fake GitHub, which mints tokens
 * carrying a sentinel prefix, for a client whose key is a sentinel, at the
 * most verbose log level with telemetry on. Every captured log line, span
 * attribute, metric label, `/status` body and non-200 response is searched
 * for the sentinels, the key's hash, a rejected key and any bearer header.
 * Run once with a plain logger (the allow-list alone must hold) and once with
 * the production Tessera logger (allow-list plus redaction).
 */
describe("no credential reaches any output", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const KEY_FILE = "/virtual/tessera-sentinel.pem";

  const TOKEN_SENTINEL = "tessera-sentinel-token-";
  const KEY_SENTINEL = "tessera-sentinel-client-key-0123456789";
  const KEY_SENTINEL_SHA256 = sha256Hex(KEY_SENTINEL);
  const BAD_KEY = "tessera-sentinel-bad-key-9876543210";
  const SENTINEL_CLIENTS = parseClientRegistry(
    JSON.stringify([{ client: "legate", key_sha256: KEY_SENTINEL_SHA256 }]),
  );
  const SENTINEL_POLICY = parsePolicy(
    JSON.stringify([
      { client: "legate", identities: ["app", "user"], repos: ["acme/*"], max_access: "write" },
    ]),
    SENTINEL_CLIENTS.clients(),
  );
  const FORBIDDEN = [TOKEN_SENTINEL, KEY_SENTINEL, KEY_SENTINEL_SHA256, BAD_KEY, "Bearer "];

  let app: FastifyInstance | undefined;
  let fake: FakeGitHub | undefined;
  let logDir: string | undefined;

  afterEach(async () => {
    if (app) await app.close();
    await fake?.close();
    if (logDir) fs.rmSync(logDir, { recursive: true, force: true });
    app = undefined;
    fake = undefined;
    logDir = undefined;
    vi.restoreAllMocks();
    initOtel({});
  });

  /** Every span the active tracer starts. */
  function captureSpans(): Span[] {
    const tracer = getActiveOtel().getTracer();
    const created: Span[] = [];
    const real = tracer.startSpan.bind(tracer);
    vi.spyOn(tracer, "startSpan").mockImplementation((...args: Parameters<typeof real>) => {
      const span = real(...args) as Span;
      created.push(span);
      return span;
    });
    return created;
  }

  /** Every attribute set recorded on any counter or histogram, by instrument name. */
  function captureMetrics(): Array<{ name: string; attributes: unknown }> {
    const meter = getActiveOtel().getMeter();
    const recorded: Array<{ name: string; attributes: unknown }> = [];
    vi.spyOn(meter, "createCounter").mockImplementation((name: string) => {
      return { add: (_v: number, attributes?: unknown) => recorded.push({ name, attributes }) } as never;
    });
    vi.spyOn(meter, "createHistogram").mockImplementation((name: string) => {
      return {
        record: (_v: number, attributes?: unknown) => recorded.push({ name, attributes }),
      } as never;
    });
    return recorded;
  }

  /**
   * A trace-level logger, a reader for one copy of its records (`lines`) and
   * a reader for everything it wrote to every sink (`text`).
   */
  function captureLogs(variant: "plain" | "tessera"): {
    logger: pino.Logger;
    lines: () => string;
    text: () => string;
  } {
    const stream = new PassThrough();
    const chunks: string[] = [];
    stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
    if (variant === "plain") {
      const lines = () => chunks.join("");
      return { logger: pino({ level: "trace" }, stream), lines, text: lines };
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-tessera-sentinel-"));
    logDir = dir;
    const logger = createTesseraLogger({
      env: { MARCH_TESSERA_LOG_DIR: dir },
      level: "trace",
      sync: true,
      stdout: stream,
    });
    return {
      logger,
      lines: () => chunks.join(""),
      text: () => chunks.join("") + fs.readFileSync(path.join(dir, "tessera.jsonl"), "utf-8"),
    };
  }

  for (const variant of ["plain", "tessera"] as const) {
    it(`leaks no token, key, hash or header with the ${variant} logger`, async () => {
      initOtel({ MARCH_OTEL: "1", MARCH_OTEL_ENDPOINT: "http://localhost:4318" });
      const spans = captureSpans();
      const metrics = captureMetrics();
      const logs = captureLogs(variant);

      let t = Date.parse("2026-11-15T12:00:00Z");
      fake = await startFakeGitHub({
        app: { id: 42, slug: "march-bot" },
        botUserId: 123456,
        installations: { acme: { id: 7, repos: ["widgets", "gadgets"] } },
        publicKey,
        now: () => t,
        tokenPrefix: TOKEN_SENTINEL,
      });
      const appProvider = createGitHubAppProvider({
        config: { configured: true, appId: "42", keyFile: KEY_FILE, installationId: undefined },
        client: new GitHubClient({ baseUrl: fake.baseUrl, timeoutMs: 200 }),
        now: () => t,
        readFile: (file) => {
          if (file !== KEY_FILE) throw new Error("ENOENT");
          return PEM;
        },
      });
      await appProvider.start();
      // Fails with a message carrying the token, the key and a bearer header.
      const throwingUser = stubProvider({
        id: "github-user",
        identity: "user",
        issue: async () => {
          throw new Error(`boom ${TOKEN_SENTINEL}0001 ${KEY_SENTINEL} Bearer ${KEY_SENTINEL}`);
        },
      });
      app = buildTesseraServer({
        clients: SENTINEL_CLIENTS,
        policy: SENTINEL_POLICY,
        registry: createProviderRegistry([appProvider, throwingUser]),
        logger: logs.logger,
      });
      const built = app;

      const nonOk: LightMyRequestResponse[] = [];
      const statuses: number[] = [];
      async function send(
        body: unknown,
        options: { authorization?: string | null; raw?: string } = {},
      ): Promise<LightMyRequestResponse> {
        const authorization =
          options.authorization === undefined ? `Bearer ${KEY_SENTINEL}` : options.authorization;
        const res = await built.inject({
          method: "POST",
          url: "/v1/github/token",
          headers: {
            "content-type": "application/json",
            ...(authorization === null ? {} : { authorization }),
          },
          payload: options.raw ?? JSON.stringify(body),
        });
        statuses.push(res.statusCode);
        if (res.statusCode !== 200) nonOk.push(res);
        return res;
      }
      const WIDGETS = { identity: "app", repo: "acme/widgets", access: "read" };

      const minted = await send(WIDGETS); // issued, cache miss
      expect(minted.json().token).toContain(TOKEN_SENTINEL);
      await send(WIDGETS); // issued, cache hit
      await send({ ...WIDGETS, refresh: true }); // refresh: a new mint
      await send(WIDGETS, { authorization: `Bearer ${BAD_KEY}` }); // 401, wrong key
      await send(WIDGETS, { authorization: null }); // 401, no key
      await send(undefined, { raw: `{"token":"${TOKEN_SENTINEL}x", ${KEY_SENTINEL}` }); // 400, malformed
      await send({ ...WIDGETS, token: `${TOKEN_SENTINEL}x`, clientKey: KEY_SENTINEL }); // 400, unknown fields
      await send({ ...WIDGETS, repo: "other/widgets" }); // 403
      await send({ ...WIDGETS, repo: "acme/uncovered" }); // 422
      fake.fail("token", { status: 403, body: { message: `nope ${TOKEN_SENTINEL}gh Bearer x` } });
      await send({ ...WIDGETS, repo: "acme/gadgets" }); // 502 mint_failed

      t += 55 * 60 * 1000; // inside the re-mint window, still unexpired
      fake.fail("token", { status: 503, retryAfter: "7", body: { message: `down ${TOKEN_SENTINEL}gh` } });
      await send(WIDGETS); // 200, the cached token served through the outage
      await send({ ...WIDGETS, refresh: true }); // 503, nothing to fall back to
      t += 10 * 60 * 1000; // the cached token has now expired
      await send(WIDGETS); // 503 provider_unavailable
      fake.fail("token", null);

      await send({ identity: "user", access: "write" }); // 500, message carries the sentinels

      expect(statuses).toEqual([200, 200, 200, 401, 401, 400, 400, 403, 422, 502, 200, 503, 503, 500]);
      const statusRes = await built.inject({ method: "GET", url: "/status" });
      const healthRes = await built.inject({ method: "GET", url: "/healthz" });
      expect(statusRes.statusCode).toBe(200);
      expect(healthRes.statusCode).toBe(200);

      const tokenSpans = spans.filter((span) => span.name === "tessera.issue");
      expect(tokenSpans).toHaveLength(statuses.length);
      expect(metrics.filter((m) => m.name.startsWith("march.tessera."))).toHaveLength(statuses.length);
      const logText = logs.text();
      expect(logs.lines().split("\n").filter((line) => line.includes('"msg":"tessera.audit"'))).toHaveLength(
        statuses.length,
      );

      const outputs: Array<[string, string]> = [
        ["logs", logText],
        [
          "spans",
          JSON.stringify(
            spans.map((span) => ({
              name: span.name,
              attributes: span.attributes,
              status: span.status,
              events: span.events,
            })),
          ),
        ],
        ["metrics", JSON.stringify(metrics)],
        ["/status", statusRes.body],
        ["/healthz", healthRes.body],
        ["error bodies", JSON.stringify(nonOk.map((res) => ({ body: res.body, headers: res.headers })))],
      ];
      for (const [label, text] of outputs) {
        for (const forbidden of FORBIDDEN) {
          expect(text.includes(forbidden), `${label} contains ${forbidden}`).toBe(false);
        }
      }

      const internal = logs
        .lines()
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((line) => line.msg === "tessera.audit")
        .map((line) => line.audit as Record<string, unknown>)
        .filter((audit) => audit.reason === "internal");
      expect(internal).toEqual([
        {
          caller: "legate",
          identity: "user",
          provider: "github-user",
          repo: null,
          access: "write",
          outcome: "failed",
          reason: "internal",
          cache: "n/a",
          expires_at: null,
          subject: null,
        },
      ]);
      expect(logText).not.toContain("boom");
    });
  }
});
