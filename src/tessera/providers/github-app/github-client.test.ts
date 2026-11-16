/**
 * @l1 @deterministic @ci
 *
 * Bounded GitHub client driven against the in-process fake GitHub API: the
 * four calls, their request shapes, and the one failure classifier.
 */
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import {
  CredentialInvalidError,
  MintFailedError,
  ProviderUnavailableError,
  RepoNotInstalledError,
  ACCESS_PROFILES,
  DEFAULT_RETRY_AFTER_SECONDS,
} from "../../types.js";
import { startFakeGitHub, type FakeGitHub, type FakeGitHubOptions } from "../../testing/fake-github.js";
import { signAppAssertion } from "./app-assertion.js";
import { classifyGitHubFailure, GitHubClient, GITHUB_REQUEST_TIMEOUT_MS } from "./github-client.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const assertion = signAppAssertion({ appId: "42", privateKey });

let fake: FakeGitHub | undefined;
afterEach(async () => {
  await fake?.close();
  fake = undefined;
});

async function setup(options: FakeGitHubOptions = {}, timeoutMs?: number) {
  fake = await startFakeGitHub({
    app: { id: 42, slug: "march-bot" },
    installations: {
      acme: { id: 7, repos: ["widgets"] },
      octocat: { id: 9, type: "User" },
    },
    publicKey,
    ...options,
  });
  const client = new GitHubClient({ baseUrl: fake.baseUrl, ...(timeoutMs === undefined ? {} : { timeoutMs }) });
  return { fake, client };
}

describe("GitHubClient success paths", () => {
  it("reads the app with a Bearer assertion", async () => {
    const { fake, client } = await setup();
    await expect(client.getApp(assertion)).resolves.toEqual({ id: 42, slug: "march-bot", name: "March Bot" });
    expect(fake.calls[0]).toMatchObject({ method: "GET", path: "/app", bearer: true });
  });

  it("resolves an org installation, and falls back to the user endpoint", async () => {
    const { fake, client } = await setup();
    await expect(client.getOwnerInstallation(assertion, "acme")).resolves.toEqual({ id: 7, account: "acme" });
    await expect(client.getOwnerInstallation(assertion, "octocat")).resolves.toEqual({ id: 9, account: "octocat" });
    expect(fake.calls.map((c) => c.path)).toEqual([
      "/orgs/acme/installation",
      "/orgs/octocat/installation",
      "/users/octocat/installation",
    ]);
  });

  it("reads an installation by id with its account login", async () => {
    const { fake, client } = await setup();
    await expect(client.getInstallation(assertion, 7)).resolves.toEqual({ id: 7, account: "acme" });
    expect(fake.calls[0]).toMatchObject({ method: "GET", path: "/app/installations/7", bearer: true });
  });

  it("maps an installation lookup by id to repo_not_installed on 404, provider_unavailable on 5xx", async () => {
    const { fake, client } = await setup();
    await expect(client.getInstallation(assertion, 99)).rejects.toBeInstanceOf(RepoNotInstalledError);
    fake.fail("installation", { status: 503 });
    await expect(client.getInstallation(assertion, 7)).rejects.toBeInstanceOf(ProviderUnavailableError);
    fake.fail("installation", { status: 200, body: { id: 7 } });
    await expect(client.getInstallation(assertion, 7)).rejects.toBeInstanceOf(MintFailedError);
  });

  it("mints a token for exactly the named repository and permissions", async () => {
    const { fake, client } = await setup({ now: () => Date.parse("2026-11-15T12:00:00Z"), tokenTtlMs: 60_000 });
    const result = await client.createInstallationToken(assertion, 7, {
      repositories: ["widgets"],
      permissions: ACCESS_PROFILES.write,
    });
    expect(result).toEqual({ token: "ghs_fake0001", expiresAt: "2026-11-15T12:01:00Z" });
    expect(fake.mintCount()).toBe(1);
    expect(fake.calls[0]).toMatchObject({
      method: "POST",
      path: "/app/installations/7/access_tokens",
      bearer: true,
      body: { repositories: ["widgets"], permissions: ACCESS_PROFILES.write },
    });
    fake.setTokenExpiry("2030-01-01T00:00:00Z");
    await expect(
      client.createInstallationToken(assertion, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read }),
    ).resolves.toMatchObject({ expiresAt: "2030-01-01T00:00:00Z" });
    expect(fake.mintCount()).toBe(2);
  });

  it("refuses a mint locally unless it names exactly one repository and a non-empty permission set", async () => {
    const { fake, client } = await setup();
    const scopes = [
      { repositories: [], permissions: ACCESS_PROFILES.read },
      { repositories: ["widgets", "gadgets"], permissions: ACCESS_PROFILES.read },
      { repositories: [""], permissions: ACCESS_PROFILES.read },
      { repositories: ["widgets"], permissions: {} },
    ];
    for (const scope of scopes) {
      const error = await client.createInstallationToken(assertion, 7, scope).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MintFailedError);
      expect((error as Error).message).not.toContain("widgets");
    }
    expect(fake.mintCount()).toBe(0);
    expect(fake.calls).toHaveLength(0);
  });

  it("looks up the bot user unauthenticated with an escaped path", async () => {
    const { fake, client } = await setup({ botUserId: 555 });
    await expect(client.getBotUser("march-bot")).resolves.toEqual({ id: 555, login: "march-bot[bot]" });
    expect(fake.calls[0]).toMatchObject({ path: "/users/march-bot%5Bbot%5D", bearer: false });
  });

  it("escapes owner path segments", async () => {
    const { fake, client } = await setup();
    await expect(client.getOwnerInstallation(assertion, "a/b")).rejects.toBeInstanceOf(RepoNotInstalledError);
    expect(fake.calls[0]?.path).toBe("/orgs/a%2Fb/installation");
  });
});

describe("GitHubClient failure classification", () => {
  it("bounds a hanging call and maps it to provider_unavailable", async () => {
    const { fake, client } = await setup({}, 150);
    fake.fail("token", { hang: true });
    const started = Date.now();
    const error = await client
      .createInstallationToken(assertion, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("uses a single default timeout", () => {
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeGreaterThan(0);
    expect(GITHUB_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(10_000);
  });

  it("maps connection refused to provider_unavailable", async () => {
    const { fake, client } = await setup();
    await fake.refuseConnections();
    await expect(client.getApp(assertion)).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("maps 5xx to provider_unavailable and forwards a numeric Retry-After", async () => {
    const { fake, client } = await setup();
    fake.fail("app", { status: 503, retryAfter: "17" });
    const error = (await client.getApp(assertion).catch((e: unknown) => e)) as ProviderUnavailableError;
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.retryAfterSeconds).toBe(17);

    fake.fail("app", { status: 500, retryAfter: "Wed, 21 Oct 2026 07:28:00 GMT" });
    const fallback = (await client.getApp(assertion).catch((e: unknown) => e)) as ProviderUnavailableError;
    expect(fallback.retryAfterSeconds).toBe(DEFAULT_RETRY_AFTER_SECONDS);
  });

  it("maps a rejected app credential to credential_invalid", async () => {
    const { client } = await setup();
    const { privateKey: otherKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const bad = signAppAssertion({ appId: "42", privateKey: otherKey });
    await expect(client.getApp(bad)).rejects.toBeInstanceOf(CredentialInvalidError);
    await expect(client.getOwnerInstallation(bad, "acme")).rejects.toBeInstanceOf(CredentialInvalidError);
    await expect(
      client.createInstallationToken(bad, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read }),
    ).rejects.toBeInstanceOf(CredentialInvalidError);
  });

  it("maps an uninstalled owner to repo_not_installed", async () => {
    const { fake, client } = await setup();
    fake.uninstallOwner("acme");
    await expect(client.getOwnerInstallation(assertion, "acme")).rejects.toBeInstanceOf(RepoNotInstalledError);
    await expect(
      client.createInstallationToken(assertion, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read }),
    ).rejects.toBeInstanceOf(RepoNotInstalledError);
  });

  it("maps a mint refused for an uncovered repository to repo_not_installed", async () => {
    const { fake, client } = await setup();
    await expect(
      client.createInstallationToken(assertion, 7, { repositories: ["gadgets"], permissions: ACCESS_PROFILES.read }),
    ).rejects.toBeInstanceOf(RepoNotInstalledError);
    expect(fake.issuedCount()).toBe(0);
  });

  it("maps anything else to mint_failed, including secondary rate limits (SD-011)", async () => {
    const { fake, client } = await setup();
    fake.fail("token", { status: 403, body: { message: "secret ghs_leak" } });
    const error = (await client
      .createInstallationToken(assertion, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read })
      .catch((e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(MintFailedError);
    expect(error.message).not.toContain("ghs_leak");
    expect(error.message).not.toContain(assertion);

    fake.fail("token", { status: 429 });
    await expect(
      client.createInstallationToken(assertion, 7, { repositories: ["widgets"], permissions: ACCESS_PROFILES.read }),
    ).rejects.toBeInstanceOf(MintFailedError);

    fake.fail("user", { status: 404 });
    await expect(client.getBotUser("march-bot")).rejects.toBeInstanceOf(MintFailedError);
  });

  it("maps a malformed success body to mint_failed", async () => {
    const { fake, client } = await setup();
    fake.fail("app", { status: 200, body: { unexpected: true } });
    await expect(client.getApp(assertion)).rejects.toBeInstanceOf(MintFailedError);
  });

  it("classifies a 401 on the unauthenticated user lookup as mint_failed", () => {
    expect(classifyGitHubFailure("user", { kind: "status", status: 401 })).toBeInstanceOf(MintFailedError);
    expect(classifyGitHubFailure("app", { kind: "status", status: 404 })).toBeInstanceOf(MintFailedError);
    expect(classifyGitHubFailure("installation", { kind: "timeout" })).toBeInstanceOf(ProviderUnavailableError);
  });
});
