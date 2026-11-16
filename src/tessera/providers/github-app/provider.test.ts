/**
 * @l1 @deterministic @ci
 *
 * The github-app credential provider driven against the in-process fake
 * GitHub API: downscoped minting, Installation Binding resolution, bot
 * identity derivation and the Provider Status lifecycle.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  ACCESS_PROFILES,
  CredentialInvalidError,
  MintFailedError,
  ProviderUnavailableError,
  RepoNotInstalledError,
  TesseraValidationError,
} from "../../types.js";
import { startFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "../../testing/fake-github.js";
import { GitHubClient } from "./github-client.js";
import { createGitHubAppProvider, GITHUB_APP_PROVIDER_ID, type GitHubAppProviderConfig } from "./provider.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const KEY_FILE = "/virtual/tessera-app.pem";
const readKey = (path: string): string => {
  if (path !== KEY_FILE) throw new Error("ENOENT");
  return PEM;
};

let fake: FakeGitHub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

interface SetupOptions {
  readonly fakeOptions?: FakeGitHubOptions;
  readonly config?: Partial<GitHubAppProviderConfig>;
  readonly timeoutMs?: number;
  readonly readFile?: (path: string) => string;
}

async function setup({ fakeOptions = {}, config = {}, timeoutMs, readFile = readKey }: SetupOptions = {}) {
  fake = await startFakeGitHub({
    app: { id: 42, slug: "march-bot" },
    botUserId: 123456,
    installations: {
      acme: { id: 7, repos: ["widgets", "gadgets"] },
      octocat: { id: 9, type: "User" },
    },
    publicKey,
    ...fakeOptions,
  });
  const client = new GitHubClient({ baseUrl: fake.baseUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  const provider = createGitHubAppProvider({
    config: { configured: true, appId: "42", keyFile: KEY_FILE, installationId: undefined, ...config },
    client,
    readFile,
  });
  return { fake, provider };
}

const endpoints = (f: FakeGitHub) => f.calls.map((c) => c.endpoint);

describe("github-app provider identity", () => {
  it("is the app identity provider and starts unconfigured until start()", async () => {
    const { provider } = await setup();
    expect(provider.id).toBe(GITHUB_APP_PROVIDER_ID);
    expect(provider.identity).toBe("app");
    expect(provider.status().state).toBe("unconfigured");
  });

  it("derives the bot login from GitHub at start and reports ok", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    expect(provider.status()).toEqual({
      provider: "github-app",
      state: "ok",
      login: "march-bot[bot]",
      credential_expires_at: null,
      expiry_warning: false,
      last_error: null,
    });
    expect(fake.calls.map((c) => c.path)).toEqual(["/app", "/users/march-bot%5Bbot%5D"]);
  });

  it("goes invalid on an unreadable or unparseable key without throwing", async () => {
    const unreadable = await setup({ readFile: () => { throw new Error("EACCES"); } });
    await expect(unreadable.provider.start()).resolves.toBeUndefined();
    expect(unreadable.provider.status()).toMatchObject({ state: "invalid", login: null, last_error: "credential_invalid" });
    await expect(unreadable.provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(unreadable.fake.calls).toHaveLength(0);
    await unreadable.fake.close();

    const garbage = await setup({ readFile: () => "not a key" });
    await garbage.provider.start();
    expect(garbage.provider.status().state).toBe("invalid");
  });

  it("goes invalid when GitHub rejects the app credential at start", async () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const otherPem = other.export({ type: "pkcs8", format: "pem" }).toString();
    const { fake, provider } = await setup({ readFile: () => otherPem });
    await provider.start();
    expect(provider.status()).toMatchObject({ state: "invalid", login: null, last_error: "credential_invalid" });
    const before = fake.calls.length;
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(fake.calls).toHaveLength(before);
  });

  it("is degraded with no login when the identity lookup fails, refuses mints, and retries later", async () => {
    const { fake, provider } = await setup();
    fake.fail("app", { status: 503 });
    await expect(provider.start()).resolves.toBeUndefined();
    expect(provider.status()).toMatchObject({ state: "degraded", login: null, last_error: "provider_unavailable" });

    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(fake.mintCount()).toBe(0);

    fake.fail("app", null);
    const result = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(result.identity).toBe("march-bot[bot]");
    expect(provider.status()).toMatchObject({ state: "ok", login: "march-bot[bot]", last_error: null });
  });

  it("refuses with provider_unavailable when the bot user lookup fails for any reason", async () => {
    const { fake, provider } = await setup();
    fake.fail("user", { status: 404 });
    await provider.start();
    expect(provider.status()).toMatchObject({ state: "degraded", login: null });
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(fake.mintCount()).toBe(0);
  });

  it("goes degraded within the timeout bound when GitHub hangs at start", async () => {
    const { fake, provider } = await setup({ timeoutMs: 100 });
    fake.fail("app", { hang: true });
    const started = Date.now();
    await provider.start();
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(provider.status()).toMatchObject({ state: "degraded", login: null, last_error: "provider_unavailable" });
  });
});

describe("github-app provider minting", () => {
  it("mints for exactly the one repository and the access profile's permissions", async () => {
    const { fake, provider } = await setup({
      fakeOptions: { now: () => Date.parse("2026-11-15T12:00:00Z"), tokenTtlMs: 60 * 60 * 1000 },
    });
    await provider.start();
    const result = await provider.issue({ repo: "acme/widgets", access: "write" });
    expect(result).toEqual({
      token: "ghs_fake0001",
      expiresAt: "2026-11-15T13:00:00Z",
      identity: "march-bot[bot]",
      commitIdentity: { name: "march-bot[bot]", email: "123456+march-bot[bot]@users.noreply.github.com" },
      cache: "miss",
    });
    const mint = fake.calls.find((c) => c.endpoint === "token");
    expect(mint).toMatchObject({
      method: "POST",
      path: "/app/installations/7/access_tokens",
      body: { repositories: ["widgets"], permissions: ACCESS_PROFILES.write },
    });

    await provider.issue({ repo: "acme/widgets", access: "read" });
    const mints = fake.calls.filter((c) => c.endpoint === "token");
    expect(mints[1]?.body).toEqual({ repositories: ["widgets"], permissions: ACCESS_PROFILES.read });
  });

  it("returns repo_not_installed for an uninstalled owner with no mint attempted", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    await expect(provider.issue({ repo: "stranger/thing", access: "read" })).rejects.toBeInstanceOf(
      RepoNotInstalledError,
    );
    expect(fake.mintCount()).toBe(0);
  });

  it("never widens scope when the installation excludes the repository", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    await expect(provider.issue({ repo: "acme/secret", access: "write" })).rejects.toBeInstanceOf(
      RepoNotInstalledError,
    );
    const mints = fake.calls.filter((c) => c.endpoint === "token");
    expect(mints).toHaveLength(1);
    expect(mints[0]?.body).toEqual({ repositories: ["secret"], permissions: ACCESS_PROFILES.write });
  });

  it("remembers a successful owner lookup and resolves user-account owners", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.reset();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    await provider.issue({ repo: "acme/gadgets", access: "read" });
    expect(endpoints(fake)).toEqual(["installation", "token", "token"]);

    fake.reset();
    await provider.issue({ repo: "octocat/hello", access: "read" });
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/orgs/octocat/installation",
      "/users/octocat/installation",
      "/app/installations/9/access_tokens",
    ]);
  });

  it("does not remember a failed lookup", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.uninstallOwner("acme");
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      RepoNotInstalledError,
    );
    fake.setInstallation("acme", { id: 11 });
    fake.reset();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/orgs/acme/installation",
      "/app/installations/11/access_tokens",
    ]);
  });

  it("drops a binding when a mint against it reports not-found, so a later request resolves again", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    fake.uninstallOwner("acme");
    await expect(provider.issue({ repo: "acme/widgets", access: "read", refresh: true })).rejects.toBeInstanceOf(
      RepoNotInstalledError,
    );
    fake.setInstallation("acme", { id: 12 });
    fake.reset();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/orgs/acme/installation",
      "/app/installations/12/access_tokens",
    ]);
  });

  it("uses the configured installation override and skips the lookup", async () => {
    const { fake, provider } = await setup({ config: { installationId: 7 } });
    await provider.start();
    fake.reset();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(fake.calls.map((c) => c.path)).toEqual(["/app/installations/7/access_tokens"]);
  });

  it("takes the bot identity only from GitHub, never from configuration", async () => {
    const { provider } = await setup({
      fakeOptions: { app: { id: 42, slug: "other-app" }, botUserId: 99 },
      config: { login: "spoofed[bot]", commitIdentity: { name: "x", email: "x@y" } } as Partial<GitHubAppProviderConfig>,
    });
    await provider.start();
    const result = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(result.identity).toBe("other-app[bot]");
    expect(result.commitIdentity).toEqual({ name: "other-app[bot]", email: "99+other-app[bot]@users.noreply.github.com" });
  });

  it("refuses an unknown access level before any GitHub call", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.reset();
    await expect(
      provider.issue({ repo: "acme/widgets", access: "admin" as unknown as "read" }),
    ).rejects.toBeInstanceOf(TesseraValidationError);
    expect(fake.mintCount()).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("requires a repository", async () => {
    const { provider } = await setup();
    await provider.start();
    await expect(provider.issue({ access: "read" })).rejects.toBeInstanceOf(TesseraValidationError);
  });
});

describe("github-app provider token cache", () => {
  const T0 = Date.parse("2026-11-15T12:00:00Z");
  const MINUTE = 60 * 1000;

  async function cached(config: Partial<GitHubAppProviderConfig> = {}, timeoutMs?: number) {
    let t = T0;
    const now = () => t;
    fake = await startFakeGitHub({
      app: { id: 42, slug: "march-bot" },
      botUserId: 123456,
      installations: { acme: { id: 7, repos: ["widgets", "gadgets"] } },
      publicKey,
      now,
      tokenTtlMs: 60 * MINUTE,
    });
    const provider = createGitHubAppProvider({
      config: { configured: true, appId: "42", keyFile: KEY_FILE, installationId: undefined, ...config },
      client: new GitHubClient({ baseUrl: fake.baseUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) }),
      now,
      readFile: readKey,
    });
    await provider.start();
    return { fake, provider, advance: (ms: number) => { t += ms; } };
  }

  it("serves a repeat request with more than ten minutes left from the cache, with no GitHub call", async () => {
    const { fake, provider, advance } = await cached();
    const first = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(first.cache).toBe("miss");
    expect(provider.cacheEntries?.()).toBe(1);

    advance(50 * MINUTE - 1000);
    fake.reset();
    const second = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(second).toEqual({ ...first, cache: "hit" });
    expect(fake.calls).toHaveLength(0);
  });

  it("re-mints when fewer than ten minutes remain", async () => {
    const { fake, provider, advance } = await cached();
    const first = await provider.issue({ repo: "acme/widgets", access: "read" });
    advance(51 * MINUTE);
    const second = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(second.cache).toBe("miss");
    expect(second.token).not.toBe(first.token);
    expect(fake.mintCount()).toBe(2);
    expect(provider.cacheEntries?.()).toBe(1);

    const third = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(third).toEqual({ ...second, cache: "hit" });
    expect(fake.mintCount()).toBe(2);
  });

  it("never shares an entry between repositories or access levels", async () => {
    const { fake, provider } = await cached();
    const a = await provider.issue({ repo: "acme/widgets", access: "read" });
    const b = await provider.issue({ repo: "acme/gadgets", access: "read" });
    const c = await provider.issue({ repo: "acme/widgets", access: "write" });
    expect(new Set([a.token, b.token, c.token]).size).toBe(3);
    expect([a.cache, b.cache, c.cache]).toEqual(["miss", "miss", "miss"]);
    expect(fake.mintCount()).toBe(3);
    expect(provider.cacheEntries?.()).toBe(3);
  });

  it("evicts the entry before issuing when refresh is set", async () => {
    const { fake, provider } = await cached({ installationId: 7 });
    const first = await provider.issue({ repo: "acme/widgets", access: "read" });
    const refreshed = await provider.issue({ repo: "acme/widgets", access: "read", refresh: true });
    expect(refreshed.cache).toBe("miss");
    expect(refreshed.token).not.toBe(first.token);
    expect(fake.mintCount()).toBe(2);
    expect(provider.cacheEntries?.()).toBe(1);
  });

  it("does not cache a failed mint", async () => {
    const { fake, provider } = await cached();
    fake.fail("token", { status: 502 });
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(provider.cacheEntries?.()).toBe(0);
    fake.fail("token", null);
    expect((await provider.issue({ repo: "acme/widgets", access: "read" })).cache).toBe("miss");
  });

  it("does not count expired entries", async () => {
    const { provider, advance } = await cached();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    advance(61 * MINUTE);
    expect(provider.cacheEntries?.()).toBe(0);
  });

  it("clears the whole cache on demand", async () => {
    const { fake, provider } = await cached();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    await provider.issue({ repo: "acme/gadgets", access: "write" });
    provider.clearCache();
    expect(provider.cacheEntries()).toBe(0);
    expect((await provider.issue({ repo: "acme/widgets", access: "read" })).cache).toBe("miss");
    expect(fake.mintCount()).toBe(3);
  });

  it("stops serving cached tokens once the provider goes invalid", async () => {
    const { fake, provider } = await cached();
    await provider.issue({ repo: "acme/widgets", access: "read" });
    fake.fail("token", { status: 401 });
    await expect(provider.issue({ repo: "acme/gadgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(provider.cacheEntries()).toBe(0);
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
  });
});

describe("github-app provider outage fallback", () => {
  const T0 = Date.parse("2026-11-15T12:00:00Z");
  const MINUTE = 60 * 1000;

  async function outage(config: Partial<GitHubAppProviderConfig> = {}, timeoutMs = 200) {
    let t = T0;
    const now = () => t;
    fake = await startFakeGitHub({
      app: { id: 42, slug: "march-bot" },
      botUserId: 123456,
      installations: { acme: { id: 7, repos: ["widgets", "gadgets"] } },
      publicKey,
      now,
      tokenTtlMs: 60 * MINUTE,
    });
    const provider = createGitHubAppProvider({
      config: { configured: true, appId: "42", keyFile: KEY_FILE, installationId: undefined, ...config },
      client: new GitHubClient({ baseUrl: fake.baseUrl, timeoutMs }),
      now,
      readFile: readKey,
    });
    await provider.start();
    return { fake, provider, advance: (ms: number) => { t += ms; } };
  }

  const READ = { repo: "acme/widgets", access: "read" } as const;

  for (const [label, failure] of [
    ["a 5xx", { status: 502 }],
    ["a hang", { hang: true }],
  ] as const) {
    it(`serves the stale unexpired token on ${label}, goes degraded, then recovers with a new token`, async () => {
      const { fake, provider, advance } = await outage();
      const first = await provider.issue(READ);
      advance(55 * MINUTE); // stale: inside the ten-minute window, still unexpired
      fake.fail("token", failure);
      const started = Date.now();
      const served = await provider.issue(READ);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(served).toEqual({ ...first, cache: "hit" });
      expect(provider.status()).toMatchObject({ state: "degraded", last_error: "provider_unavailable" });
      expect(provider.cacheEntries()).toBe(1);

      fake.fail("token", null);
      const recovered = await provider.issue(READ);
      expect(recovered.cache).toBe("miss");
      expect(recovered.token).not.toBe(first.token);
      expect(provider.status()).toMatchObject({ state: "ok", last_error: null });
    });
  }

  it("serves the stale token to every joiner of a failed shared re-mint", async () => {
    const { fake, provider, advance } = await outage();
    const first = await provider.issue(READ);
    advance(55 * MINUTE);
    fake.reset();
    fake.fail("token", { status: 503 });
    const results = await Promise.all(Array.from({ length: 4 }, () => provider.issue(READ)));
    expect(fake.mintCount()).toBe(1);
    for (const r of results) expect(r).toEqual({ ...first, cache: "hit" });
  });

  it("returns provider_unavailable on an outage with no entry", async () => {
    const { fake, provider } = await outage();
    await provider.issue({ repo: "acme/gadgets", access: "read" }); // other key; remembers the binding
    fake.fail("token", { hang: true });
    const started = Date.now();
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  for (const [label, failure] of [
    ["a 5xx", { status: 502 }],
    ["a hang", { hang: true }],
  ] as const) {
    it(`never serves an expired token on ${label}`, async () => {
      const { fake, provider, advance } = await outage();
      await provider.issue(READ);
      advance(60 * MINUTE); // exactly at expiry
      fake.fail("token", failure);
      const started = Date.now();
      await expect(provider.issue(READ)).rejects.toBeInstanceOf(ProviderUnavailableError);
      expect(Date.now() - started).toBeLessThan(2_000);
      expect(provider.cacheEntries()).toBe(0);
    });
  }

  it("does not serve a cached token to a refresh request during an outage", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.fail("token", { status: 502 });
    await expect(provider.issue({ ...READ, refresh: true })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("does not serve the stale token to a refresh request that joined the failed re-mint", async () => {
    const { fake, provider, advance } = await outage({}, 300);
    const first = await provider.issue(READ);
    advance(55 * MINUTE);
    fake.fail("token", { hang: true });
    const plain = provider.issue(READ);
    const deadline = Date.now() + 2_000;
    while (fake.mintCount() < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 5));
    const refreshed = provider.issue({ ...READ, refresh: true }).catch((e: unknown) => e);
    expect(await plain).toEqual({ ...first, cache: "hit" });
    expect(await refreshed).toBeInstanceOf(ProviderUnavailableError);
    expect(fake.mintCount()).toBe(2);
  });

  it("never masks repo_not_installed (404 or 422) with a cached token", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.setInstallation("acme", { id: 7, repos: ["gadgets"] }); // 422 on re-mint
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(RepoNotInstalledError);
    fake.uninstallOwner("acme"); // 404 on re-mint
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(RepoNotInstalledError);
  });

  it("never masks credential_invalid (401) and serves nothing once invalid", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.fail("token", { status: 401 });
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(CredentialInvalidError);
    fake.fail("token", { status: 502 });
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(CredentialInvalidError);
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
  });

  it("never masks mint_failed (403) with a cached token", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.fail("token", { status: 403 });
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(MintFailedError);
  });

  it("serves the stale token with the installation override and an outage on every endpoint", async () => {
    const { fake, provider, advance } = await outage({ installationId: 7 });
    const first = await provider.issue(READ);
    advance(55 * MINUTE);
    for (const endpoint of ["app", "installation", "token", "user"] as const) fake.fail(endpoint, { status: 503 });
    expect(await provider.issue(READ)).toEqual({ ...first, cache: "hit" });
  });

  it("serves the stale token when the owner's binding is remembered, without a lookup", async () => {
    const { fake, provider, advance } = await outage();
    const first = await provider.issue(READ);
    advance(55 * MINUTE);
    fake.reset();
    fake.fail("installation", { status: 503 });
    fake.fail("token", { status: 503 });
    expect(await provider.issue(READ)).toEqual({ ...first, cache: "hit" });
    expect(endpoints(fake)).toEqual(["token"]);
  });

  it("propagates an outage on the installation lookup when the binding is not known", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.uninstallOwner("acme"); // the re-mint 404s and drops the binding
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(RepoNotInstalledError);
    fake.setInstallation("acme", { id: 7, repos: ["widgets", "gadgets"] });
    fake.fail("installation", { status: 503 });
    await expect(provider.issue(READ)).rejects.toBeInstanceOf(ProviderUnavailableError);
    expect(provider.cacheEntries()).toBe(1); // the entry exists, but its key cannot be determined
  });

  it("never serves another key's token", async () => {
    const { fake, provider, advance } = await outage();
    await provider.issue(READ);
    advance(55 * MINUTE);
    fake.fail("token", { status: 502 });
    await expect(provider.issue({ repo: "acme/widgets", access: "write" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    await expect(provider.issue({ repo: "acme/gadgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });
});

describe("github-app provider mint coalescing", () => {
  async function waitForMints(f: FakeGitHub, count: number): Promise<void> {
    const deadline = Date.now() + 2_000;
    while (f.mintCount() < count && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(f.mintCount()).toBe(count);
  }

  it("shares one mint (and one installation lookup) among concurrent identical requests", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.reset();
    const results = await Promise.all(
      Array.from({ length: 5 }, () => provider.issue({ repo: "acme/widgets", access: "read" })),
    );
    expect(fake.mintCount()).toBe(1);
    expect(endpoints(fake).filter((e) => e === "installation")).toHaveLength(1);
    expect(new Set(results.map((r) => r.token)).size).toBe(1);
    expect(results.map((r) => r.cache)).toEqual(["miss", "miss", "miss", "miss", "miss"]);
    expect(provider.cacheEntries()).toBe(1);
  });

  it("does not make a request for another key wait on a hanging mint", async () => {
    const { fake, provider } = await setup({ timeoutMs: 1_500 });
    await provider.start();
    await provider.issue({ repo: "acme/gadgets", access: "write" }); // remember the binding
    fake.reset();

    fake.fail("token", { hang: true });
    let hungSettled = false;
    const hung = provider
      .issue({ repo: "acme/widgets", access: "read" })
      .catch((e: unknown) => e)
      .finally(() => {
        hungSettled = true;
      });
    await waitForMints(fake, 1);
    fake.fail("token", null);

    const other = await provider.issue({ repo: "acme/widgets", access: "write" });
    expect(other.cache).toBe("miss");
    expect(hungSettled).toBe(false);
    expect(fake.mintCount()).toBe(2);
    expect(await hung).toBeInstanceOf(ProviderUnavailableError);
  });

  it("does not retain a failed shared mint; the next request mints again", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.reset();
    fake.fail("token", { status: 502 });
    const failed = await Promise.allSettled(
      Array.from({ length: 3 }, () => provider.issue({ repo: "acme/widgets", access: "read" })),
    );
    expect(fake.mintCount()).toBe(1);
    for (const outcome of failed) {
      expect(outcome.status).toBe("rejected");
      expect((outcome as PromiseRejectedResult).reason).toBeInstanceOf(ProviderUnavailableError);
    }

    fake.fail("token", null);
    const next = await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(next.cache).toBe("miss");
    expect(fake.mintCount()).toBe(2);
  });

  it("lets a refresh request join a mint already in flight for the same key", async () => {
    const { fake, provider } = await setup({ timeoutMs: 300 });
    await provider.start();
    await provider.issue({ repo: "acme/gadgets", access: "read" }); // remember the binding
    fake.reset();
    fake.fail("token", { hang: true });
    const first = provider.issue({ repo: "acme/widgets", access: "read" }).catch((e: unknown) => e);
    await waitForMints(fake, 1);
    const refreshed = provider.issue({ repo: "acme/widgets", access: "read", refresh: true }).catch((e: unknown) => e);
    expect(await first).toBeInstanceOf(ProviderUnavailableError);
    expect(await refreshed).toBe(await first);
    expect(fake.mintCount()).toBe(1);
  });
});

describe("github-app provider status lifecycle", () => {
  it("ok -> degraded on a 5xx or hang, then back to ok on the next success", async () => {
    const { fake, provider } = await setup({ timeoutMs: 100 });
    await provider.start();
    fake.fail("token", { status: 502 });
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(provider.status()).toMatchObject({ state: "degraded", login: "march-bot[bot]", last_error: "provider_unavailable" });

    fake.fail("token", { hang: true });
    const started = Date.now();
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
    expect(Date.now() - started).toBeLessThan(2_000);

    fake.fail("token", null);
    await provider.issue({ repo: "acme/widgets", access: "read" });
    expect(provider.status()).toMatchObject({ state: "ok", last_error: null });
  });

  it("goes invalid on a 401 mid-run and keeps refusing with credential_invalid", async () => {
    const { fake, provider } = await setup();
    await provider.start();
    fake.fail("token", { status: 401 });
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
    fake.fail("token", null);
    const mints = fake.mintCount();
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(fake.mintCount()).toBe(mints);
  });

  it("stays invalid when a concurrent mint fails with a 5xx or timeout after a 401", async () => {
    const { fake, provider } = await setup({ timeoutMs: 300 });
    await provider.start();
    await provider.issue({ repo: "acme/widgets", access: "write" }); // remember the binding (other cache key)
    fake.reset();

    // Request B: its mint hangs and will time out (provider_unavailable).
    fake.fail("token", { hang: true });
    const b = provider.issue({ repo: "acme/widgets", access: "read" }).catch((e: unknown) => e);
    const deadline = Date.now() + 2_000;
    while (fake.mintCount() < 1 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    expect(fake.mintCount()).toBe(1);

    // Request A (another cache key, so it does not join B's mint): its mint
    // gets a 401 while B is still in flight.
    fake.fail("token", { status: 401 });
    await expect(provider.issue({ repo: "acme/gadgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });

    expect(await b).toBeInstanceOf(ProviderUnavailableError);
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });

    // A later 5xx on another in-flight path does not move it either.
    fake.fail("token", { status: 502 });
    await expect(provider.issue({ repo: "acme/widgets", access: "read" })).rejects.toBeInstanceOf(
      CredentialInvalidError,
    );
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
  });

  it("never exposes token or key material in status", async () => {
    const { provider } = await setup();
    await provider.start();
    const result = await provider.issue({ repo: "acme/widgets", access: "read" });
    const text = JSON.stringify(provider.status());
    expect(text).not.toContain(result.token);
    expect(text).not.toContain("PRIVATE KEY");
  });
});
