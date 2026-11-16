/** @l1 @deterministic @ci */
import http from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TesseraClient, TesseraClientError, getGitHubToken } from "./client.js";
import { recordTesseraFallback, tesseraConsumerService } from "../observability/tessera-client-metrics.js";

const warn = vi.fn();
vi.mock("../observability/logger.js", () => ({ createServiceLogger: () => ({ warn }) }));
vi.mock("../observability/tessera-client-metrics.js", async importOriginal => ({
  ...await importOriginal<typeof import("../observability/tessera-client-metrics.js")>(), recordTesseraFallback: vi.fn(),
}));
const req = { identity: "app", repo: "acme/widgets", access: "read" } as const;
const wire = () => ({ token: "SECRET", expires_at: new Date(Date.now() + 3_600_000).toISOString(), identity: "march[bot]",
  commit_identity: { name: "march[bot]", email: "123+march[bot]@users.noreply.github.com" }, access: "read", repo: req.repo });
const env = () => ({ MARCH_TESSERA_URL: "http://tessera", MARCH_TESSERA_CLIENT_KEY: "KEY" });
function setup(body: unknown = wire(), extraEnv: NodeJS.ProcessEnv = {}) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
  const client = new TesseraClient({ env: { ...env(), ...extraEnv }, fetchImpl });
  return { client, fetchImpl };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.unstubAllGlobals(); vi.clearAllMocks(); });
describe("Tessera client", () => {
  it("obtains an entitlement from a local fake Tessera over HTTP", async () => {
    const seen: { url?: string; auth?: string; body?: unknown } = {};
    const server = http.createServer(async (request, response) => {
      seen.url = request.url;
      seen.auth = request.headers.authorization;
      let body = "";
      for await (const chunk of request) body += chunk;
      seen.body = JSON.parse(body);
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify(wire()));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address() as { port: number };
      const client = new TesseraClient({ baseUrl: "http://127.0.0.1:" + address.port, clientKey: "FAKE_KEY", env: {} });
      expect((await client.issueGitHubToken(req)).source).toBe("tessera");
      expect(seen).toEqual({ url: "/v1/github/token", auth: "Bearer FAKE_KEY", body: req });
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
  it("authenticates, maps the wire shape, forwards correlation and refresh", async () => {
    const { client, fetchImpl } = setup();
    expect(await client.issueGitHubToken({ ...req, refresh: true, sliceId: "slice-1" })).toMatchObject({
      token: "SECRET", source: "tessera", identity: "march[bot]", commitIdentity: { name: "march[bot]" },
    });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://tessera/v1/github/token");
    expect(init).toMatchObject({ method: "POST", redirect: "error", headers: {
      authorization: "Bearer KEY", "x-march-slice-id": "slice-1", "content-type": "application/json",
    } });
    expect(JSON.parse(init!.body as string)).toEqual({ ...req, refresh: true });
  });
  it("explicit configuration overrides environment and missing wiring fails closed", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(Response.json(wire()));
    await new TesseraClient({ baseUrl: "http://explicit/", clientKey: "explicit", env: env(), fetchImpl }).issueGitHubToken(req);
    expect(fetchImpl.mock.calls[0][0]).toBe("http://explicit/v1/github/token");
    await expect(new TesseraClient({ env: {}, fetchImpl }).issueGitHubToken(req)).rejects.toMatchObject({ code: "unconfigured" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
  it("preserves protocol codes and status without exposing server secrets", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(Response.json({ error: { code: "policy_denied", message: "SECRET KEY" } }, { status: 403 }));
    try { await client.issueGitHubToken(req); throw Error("expected failure"); }
    catch (e) { expect(e).toBeInstanceOf(TesseraClientError); expect(e).toMatchObject({ code: "policy_denied", status: 403 }); expect(String(e)).not.toContain("SECRET"); }
  });
  it.each([{}, { ...wire(), repo: "other/repo" }, { ...wire(), expires_at: null }, { ...wire(), access: "write" }, { ...wire(), commit_identity: null }])("rejects malformed or differently scoped entitlements", async body => {
    await expect(setup(body).client.issueGitHubToken(req)).rejects.toMatchObject({ code: "invalid_response", status: 200 });
  });
  it("sanitizes invalid JSON and transport exceptions", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockResolvedValue(new Response("SECRET"));
    await expect(client.issueGitHubToken(req)).rejects.toMatchObject({ code: "invalid_response", message: "Tessera request failed" });
    fetchImpl.mockRejectedValue(Error("SECRET KEY"));
    await expect(client.issueGitHubToken(req)).rejects.toMatchObject({ code: "unreachable", message: "Tessera request failed" });
  });
  it.each(["fetch", "body", "status", "health"])("bounds %s even when the implementation ignores abort", async kind => {
    vi.useFakeTimers();
    const { client, fetchImpl } = setup();
    const never = new Promise<never>(() => {});
    fetchImpl.mockImplementation(() => kind === "fetch" ? never : Promise.resolve({ status: 200, text: () => never } as unknown as Response));
    const result = kind === "health" ? expect(client.reachable()).resolves.toBe(false)
      : expect(kind === "status" ? client.status() : client.issueGitHubToken(req)).rejects.toMatchObject({ code: "unreachable" });
    await vi.advanceTimersByTimeAsync(10_000);
    await result;
    expect((fetchImpl.mock.calls[0][1]!.signal as AbortSignal).aborted).toBe(true);
  });
  it("reuses only fresh matching scopes, with defensive copies and refresh eviction", async () => {
    vi.useFakeTimers();
    const { client, fetchImpl } = setup();
    const first = await client.issueGitHubToken(req);
    first.token = "mutated";
    first.commitIdentity!.name = "mutated";
    expect(await client.issueGitHubToken(req)).toMatchObject({ token: "SECRET", commitIdentity: { name: "march[bot]" } });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3_000_000); // Exactly ten minutes remain.
    await client.issueGitHubToken(req);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    await client.issueGitHubToken({ ...req, refresh: true });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    fetchImpl.mockRejectedValue(Error("down"));
    await expect(client.issueGitHubToken({ ...req, refresh: true })).rejects.toMatchObject({ code: "unreachable" });
    await expect(client.issueGitHubToken(req)).rejects.toMatchObject({ code: "unreachable" });
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it.each([true, false])("does not restore a pre-refresh token after refresh success=%s", async succeeds => {
    const { client, fetchImpl } = setup();
    let finishOld!: (value: Response) => void;
    fetchImpl.mockImplementationOnce(() => new Promise(resolve => { finishOld = resolve; }));
    const old = client.issueGitHubToken(req);
    if (succeeds) fetchImpl.mockImplementationOnce(async () => Response.json({ ...wire(), token: "NEW" }));
    else fetchImpl.mockRejectedValueOnce(Error("offline"));
    const refreshed = client.issueGitHubToken({ ...req, refresh: true });
    if (succeeds) expect((await refreshed).token).toBe("NEW");
    else await expect(refreshed).rejects.toMatchObject({ code: "unreachable" });
    finishOld(Response.json({ ...wire(), token: "OLD" }));
    await old;
    expect((await client.issueGitHubToken(req)).token).toBe(succeeds ? "NEW" : "SECRET");
    expect(fetchImpl).toHaveBeenCalledTimes(succeeds ? 2 : 3);
  });
  it("does not share cache by repo, access, identity, or client configuration", async () => {
    const { client, fetchImpl } = setup();
    fetchImpl.mockImplementation(async (_url, init) => {
      const r = JSON.parse(init!.body as string);
      return Response.json({ ...wire(), repo: r.identity === "user" ? null : r.repo,
        access: r.access, commit_identity: r.identity === "user" ? null : wire().commit_identity });
    });
    await client.issueGitHubToken(req);
    await client.issueGitHubToken({ ...req, repo: "acme/other" });
    await client.issueGitHubToken({ ...req, access: "write" });
    await client.issueGitHubToken({ ...req, identity: "user" });
    await new TesseraClient({ env: { ...env(), MARCH_TESSERA_CLIENT_KEY: "OTHER" }, fetchImpl }).issueGitHubToken(req);
    expect(fetchImpl).toHaveBeenCalledTimes(5);
  });
  it("does not cache unknown expiry user tokens or expired installation tokens", async () => {
    const { client, fetchImpl } = setup({ ...wire(), expires_at: null, repo: null, commit_identity: null });
    await client.issueGitHubToken({ ...req, identity: "user" });
    await client.issueGitHubToken({ ...req, identity: "user" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    fetchImpl.mockImplementation(async () => Response.json({ ...wire(), expires_at: new Date(Date.now() - 1).toISOString() }));
    await client.issueGitHubToken(req); await client.issueGitHubToken(req);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });
  it("convenience calls retain state and replace it when wiring changes", async () => {
    vi.stubEnv("MARCH_TESSERA_URL", "http://convenience"); vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "one");
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(wire()));
    vi.stubGlobal("fetch", fetchImpl);
    await getGitHubToken(req); await getGitHubToken(req);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    vi.stubEnv("MARCH_TESSERA_CLIENT_KEY", "two");
    await getGitHubToken(req);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, "0", "true", "1-user"])("never reads ambient tokens when disabled (%s) or for user", async flag => {
    let reads = 0;
    const settings = { ...env(), MARCH_TESSERA_GH_TOKEN_FALLBACK: flag === "1-user" ? "1" : flag };
    Object.defineProperties(settings, { GH_TOKEN: { get() { reads++; throw Error("ambient read"); } }, GITHUB_TOKEN: { get() { reads++; throw Error("ambient read"); } } });
    const client = new TesseraClient({ env: settings, fetchImpl: vi.fn().mockRejectedValue(Error("offline")) });
    await expect(client.issueGitHubToken({ ...req, identity: flag === "1-user" ? "user" : "app" })).rejects.toMatchObject({ code: "unreachable" });
    expect(reads).toBe(0);
  });
  it.each(["GH_TOKEN", "GITHUB_TOKEN"])("warns and counts every %s fallback, never caches it", async variable => {
    const { client, fetchImpl } = setup({}, { MARCH_TESSERA_GH_TOKEN_FALLBACK: "1", [variable]: "ENV_SECRET", MARCH_OTEL_SERVICE_NAME: "march-herald" });
    fetchImpl.mockRejectedValue(Error("offline SECRET"));
    for (let i = 0; i < 2; i++) expect(await client.issueGitHubToken(req)).toEqual({ token: "ENV_SECRET", expiresAt: null, identity: "unknown", commitIdentity: null, source: "env-fallback" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(warn.mock.calls)).not.toContain("SECRET");
    expect(recordTesseraFallback).toHaveBeenCalledTimes(2);
    expect(recordTesseraFallback).toHaveBeenCalledWith("herald");
  });
  it("preserves failure when fallback is enabled but absent", async () => {
    const { client, fetchImpl } = setup({}, { MARCH_TESSERA_GH_TOKEN_FALLBACK: "1" });
    fetchImpl.mockRejectedValue(Error("offline"));
    await expect(client.issueGitHubToken(req)).rejects.toMatchObject({ code: "unreachable" });
    expect(warn).not.toHaveBeenCalled();
    expect(tesseraConsumerService({ MARCH_OTEL_SERVICE_NAME: "arbitrary-secret" })).toBe("unknown");
  });
  it("checks health without issuing credentials and validates status", async () => {
    const status = { service: "march-tessera", uptime_s: 42, providers: ["github-app", "github-user"].map(provider => ({ provider, state: "ok", login: null, credential_expires_at: null, expiry_warning: false, last_error: null })), soonest_expiry: null, cache: { entries: 0 } };
    const { client, fetchImpl } = setup(status);
    expect(await client.status()).toEqual(status);
    fetchImpl.mockResolvedValue(Response.json({ status: "ok" }));
    expect(await client.reachable()).toBe(true);
    expect(fetchImpl.mock.calls.map(call => call[0])).toEqual(["http://tessera/status", "http://tessera/healthz"]);
    expect(fetchImpl.mock.calls[1][1]!.headers).toEqual({});
    fetchImpl.mockResolvedValue(Response.json({}));
    await expect(client.status()).rejects.toMatchObject({ code: "invalid_response" });
    fetchImpl.mockRejectedValue(Error("offline"));
    expect(await client.reachable()).toBe(false);
  });
});
