/**
 * @l1 @deterministic @ci
 *
 * HTTP contract test for the Tessera token route, `/healthz` and `/status`,
 * driven through an injected provider registry.
 */
import { PassThrough } from "node:stream";
import type { FastifyInstance } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESSERA_SERVICE_NAME } from "./config.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";
import {
  CredentialInvalidError,
  type CredentialProvider,
  type Identity,
  MintFailedError,
  type ProviderId,
  type ProviderIssueRequest,
  type ProviderIssueResult,
  type ProviderStatus,
  ProviderUnavailableError,
  ProviderUnconfiguredError,
  RepoNotInstalledError,
  type TesseraError,
} from "./types.js";

const SECRET_TOKEN = "ghs_SECRETTOKENVALUE1234567890";

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

  async function postToken(body: unknown, raw?: string) {
    if (!app) throw new Error("app not built");
    return app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: { "content-type": "application/json" },
      payload: raw ?? JSON.stringify(body),
    });
  }

  it("answers /healthz with ok", async () => {
    app = buildTesseraServer({ registry: createProviderRegistry([]) });
    const res = await app.inject({ method: "GET", url: "/healthz" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: "ok" });
  });

  it("reports the minimal /status shape", async () => {
    const startedAt = Date.now() - 5_000;
    app = buildTesseraServer({
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

  it("issues an entitlement through the registered provider", async () => {
    const provider = stubProvider();
    app = buildTesseraServer({ registry: createProviderRegistry([provider]) });
    const res = await postToken({
      identity: "app",
      repo: "acme/widgets",
      access: "write",
      refresh: true,
      subject: "spawn-1",
    });
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
        app = buildTesseraServer({ registry: createProviderRegistry([provider]) });
        const res = await postToken(body, raw);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toEqual({
          error: { code: "invalid_request", message: expect.any(String) },
        });
        expect(provider.issue).not.toHaveBeenCalled();
      });
    }

    it("rejects an empty body", async () => {
      app = buildTesseraServer({ registry: createProviderRegistry([]) });
      const res = await app.inject({ method: "POST", url: "/v1/github/token" });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("invalid_request");
    });
  });

  it("returns provider_unconfigured for an unconfigured app provider and stays healthy", async () => {
    app = buildTesseraServer({ registry: createProviderRegistry([unconfiguredAppProvider()]) });
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
    app = buildTesseraServer({ registry: createProviderRegistry([]) });
    const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
  });

  it("never serves a user request with the app provider (FR-009)", async () => {
    const appProvider = stubProvider();
    app = buildTesseraServer({ registry: createProviderRegistry([appProvider]) });
    const res = await postToken({ identity: "user", access: "read" });
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
    app = buildTesseraServer({ registry: createProviderRegistry([appProvider, userProvider]) });
    const res = await postToken({ identity: "user", repo: "acme/widgets", access: "read" });
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

    it("maps an unexpected provider failure to 500 internal without echoing it", async () => {
      app = buildTesseraServer({
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
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().token).toBe(SECRET_TOKEN);
    const failed = await postToken({ identity: "user", access: "read" });
    expect(failed.statusCode).toBe(500);
    const status = await app.inject({ method: "GET", url: "/status" });

    expect(status.body).not.toContain(SECRET_TOKEN);
    const logs = chunks.join("");
    expect(logs).toContain("tessera request handled");
    expect(logs).not.toContain(SECRET_TOKEN);
    expect(logs).not.toContain("subject-do-not-log");
    expect(logs).not.toContain("acme/widgets");
  });

  it("applies no caller authentication on the token route (US2)", async () => {
    app = buildTesseraServer({ registry: createProviderRegistry([stubProvider()]) });
    const res = await postToken({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(res.statusCode).toBe(200);
  });
});
