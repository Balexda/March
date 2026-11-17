/** @l0 @deterministic @ci */
import { generateKeyPairSync, createVerify } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { GithubAppProvider } from "./github-app.js";
import { ACCESS_PROFILES } from "./models.js";
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const now = Date.parse("2026-11-15T00:00:00Z");
function fake(overrides: Record<string, [number, unknown]> = {}) {
  return vi.fn<typeof fetch>(async (url, init) => {
    const path = new URL(String(url)).pathname;
    const defaults: Record<string, [number, unknown]> = {
      "/app": [200, { slug: "march-test" }],
      "/users/march-test%5Bbot%5D": [200, { id: 123, login: "march-test[bot]" }],
      "/repos/acme/widgets/installation": [200, { id: 42 }],
      "/app/installations/42/access_tokens": [201, { token: "secret-installation-token", expires_at: "2026-11-15T01:00:00Z", repositories: [{ full_name: "acme/widgets" }] }],
    };
    const match = overrides[path] ?? defaults[path];
    if (!match) throw new Error(`Unexpected fake path ${path}`);
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    return new Response(JSON.stringify(match[1]), { status: match[0] });
  });
}
function provider(fetchImpl = fake(), extra = {}) { return new GithubAppProvider({ appId: "9", privateKey: pem, fetchImpl, now: () => now, ...extra }); }
describe("GitHub App provider", () => {
  it.each(["read", "write"] as const)("mints exactly one repo with fixed %s permissions and verified identity", async access => {
    const transport = fake();
    const app = provider(transport);
    await app.start();
    const result = await app.issue({ identity: "app", access, repo: "acme/widgets" });
    expect(result).toMatchObject({ token: "secret-installation-token", identity: "march-test[bot]", commitIdentity: { name: "march-test[bot]", email: "123+march-test[bot]@users.noreply.github.com" }, access, repo: "acme/widgets", cache: "miss" });
    expect(JSON.parse(String(transport.mock.calls.at(-1)![1]!.body))).toEqual({ repositories: ["widgets"], permissions: ACCESS_PROFILES[access] });
    for (const [url, init] of transport.mock.calls) {
      const headers = new Headers(init!.headers);
      if (new URL(String(url)).pathname.startsWith("/users/")) expect(headers.has("authorization")).toBe(false);
      else expect(headers.get("authorization")).toMatch(/^Bearer [^.]+\.[^.]+\.[^.]+$/);
    }
    const assertion = (transport.mock.calls[0][1]!.headers as Record<string, string>).authorization.slice(7);
    const [head, payload, signature] = assertion.split(".");
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims).toEqual({ iss: "9", iat: now / 1000 - 60, exp: now / 1000 + 540 });
    const verifier = createVerify("RSA-SHA256"); verifier.update(`${head}.${payload}`);
    expect(verifier.verify(publicKey, signature, "base64url")).toBe(true);
  });
  it("uses installation override without a lookup or broader scope", async () => {
    const transport = fake(); const app = provider(transport, { installationId: 42 });
    await app.start(); await app.issue({ identity: "app", access: "read", repo: "acme/widgets" });
    expect(transport.mock.calls).toHaveLength(3);
  });
  it.each([404, 422])("rejects excluded or absent repository with %i", async status => {
    const app = provider(fake({ "/app/installations/42/access_tokens": [status, { message: "secret upstream content" }] }), { installationId: 42 });
    await expect(app.issue({ identity: "app", access: "write", repo: "acme/widgets" })).rejects.toMatchObject({ code: "repo_not_installed", status: 422 });
  });
  it("refuses a minted token that does not affirm the exact requested repository", async () => {
    const app = provider(fake({ "/app/installations/42/access_tokens": [201, { token: "secret", expires_at: "2026-11-15T01:00:00Z", repositories: [{ full_name: "other/widgets" }] }] }));
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "repo_not_installed" });
  });
  it.each([[401, "credential_invalid"], [500, "provider_unavailable"], [403, "mint_failed"]])("maps upstream %i to %s without response leakage", async (status, code) => {
    const app = provider(fake({ "/app": [status as number, { message: "secret-upstream" }] }));
    await app.start();
    expect(app.status().last_error).toBe(code);
    expect(JSON.stringify(app.status())).not.toContain("secret");
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code });
  });
  it("recovers identity after an outage and reports startup discovery failures safely", async () => {
    const transport = fake(); transport.mockRejectedValueOnce(new Error("secret transport error"));
    const onDiscoveryError = vi.fn(); const app = provider(transport, { onDiscoveryError });
    await app.start(); expect(app.status().state).toBe("degraded"); expect(onDiscoveryError).toHaveBeenCalledWith("provider_unavailable");
    await app.issue({ identity: "app", access: "read", repo: "acme/widgets" }); expect(app.status().state).toBe("ok");
  });
  it("bounds transports that ignore abort", async () => {
    const transport = vi.fn<typeof fetch>(() => new Promise(() => {}));
    const app = provider(transport, { timeoutMs: 10 });
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("bounds response body parsing as well as fetch", async () => {
    const transport = vi.fn<typeof fetch>(async () => ({ ok: true, status: 200, json: () => new Promise(() => {}) }) as Response);
    const app = provider(transport, { timeoutMs: 10 });
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "provider_unavailable" });
  });
  it("maps malformed upstream JSON to a safe mint failure", async () => {
    const transport = fake();
    const app = provider(transport);
    await app.start();
    transport.mockResolvedValueOnce(new Response("secret invalid JSON", { status: 200 }));
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "mint_failed", status: 502, message: "Provider could not issue a token" });
    expect(JSON.stringify(app.status())).not.toContain("secret");
  });
  it.each([
    { expires_at: "2026-11-15T02:00:00Z" },
    { expires_at: "2026-11-15T01:01:01Z" },
    { permissions: { workflows: "write" } },
    { permissions: { contents: "write" } },
    { token: null },
  ])("rejects malformed or broadened mint responses %j", async change => {
    const app = provider(fake({ "/app/installations/42/access_tokens": [201, { token: "secret", expires_at: "2026-11-15T01:00:00Z", repositories: [{ full_name: "acme/widgets" }], ...change }] }));
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "mint_failed", message: "Provider could not issue a token" });
  });
  it("accepts an hour-long token from a GitHub clock slightly ahead of Tessera", async () => {
    const app = provider(fake({ "/app/installations/42/access_tokens": [201, { token: "secret", expires_at: "2026-11-15T01:00:30Z", repositories: [{ full_name: "acme/widgets" }] }] }));
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).resolves.toMatchObject({ expiresAt: "2026-11-15T01:00:30Z" });
  });
  it("aborts the request when GitHub fails with an unread body", async () => {
    let signal: AbortSignal | undefined;
    const transport = vi.fn<typeof fetch>(async (_url, init) => { signal = init?.signal ?? undefined; return new Response(new ReadableStream(), { status: 503 }); });
    const app = provider(transport, { installationId: 42 });
    await expect(app.start()).resolves.toBeUndefined();
    expect(signal?.aborted).toBe(true);
  });
  it("starts unconfigured without calling GitHub", async () => {
    const fetchImpl = fake(); const app = new GithubAppProvider({ fetchImpl });
    await app.start(); expect(app.status().state).toBe("unconfigured");
    await expect(app.issue({ identity: "app", access: "read", repo: "acme/widgets" })).rejects.toMatchObject({ code: "provider_unconfigured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
