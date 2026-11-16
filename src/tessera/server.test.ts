/**
 * @l1 @deterministic @ci
 *
 * HTTP contract test for the Tessera token route, `/healthz` and `/status`,
 * driven through an injected provider registry: first with stub providers,
 * then with the real github-app provider against the fake GitHub API.
 */
import { generateKeyPairSync } from "node:crypto";
import { PassThrough } from "node:stream";
import type { FastifyInstance, LightMyRequestResponse } from "fastify";
import pino from "pino";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TESSERA_SERVICE_NAME } from "./config.js";
import { GitHubClient } from "./providers/github-app/github-client.js";
import { createGitHubAppProvider } from "./providers/github-app/provider.js";
import { startFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "./testing/fake-github.js";
import { buildTesseraServer, createProviderRegistry } from "./server.js";
import {
  ACCESS_PROFILES,
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
    app = buildTesseraServer({ registry: createProviderRegistry([broken, healthy]) });
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
    app = buildTesseraServer({ registry: createProviderRegistry([broken]) });
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

    it("maps a non-Tessera error carrying a 4xx statusCode to 500 internal", async () => {
      app = buildTesseraServer({
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
  }

  async function harness(options: HarnessOptions = {}): Promise<Harness> {
    fake = await startFakeGitHub({
      app: { id: 42, slug: "march-bot" },
      botUserId: 123456,
      installations: {
        acme: { id: 7, repos: ["widgets", "gadgets"] },
      },
      publicKey,
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
      post: (body) =>
        built.inject({
          method: "POST",
          url: "/v1/github/token",
          headers: { "content-type": "application/json" },
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
    const res = await h.post({ identity: "app", repo: "nobody/widgets", access: "read" });
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
    app = buildTesseraServer({ registry: createProviderRegistry([]) });
    const res = await app.inject({
      method: "POST",
      url: "/v1/github/token",
      headers: { "content-type": "application/json" },
      payload: JSON.stringify({ identity: "app", repo: "acme/widgets", access: "read" }),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error.code).toBe("provider_unconfigured");
  });
});
