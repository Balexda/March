/** @l0 @deterministic @ci */
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildTesseraServer } from "./server.js";
import { OperatorTokenProvider, OperatorTokenSource, OPERATOR_TOKEN_HORIZON_MS, OPERATOR_TOKEN_REVALIDATE_MS } from "./operator-token.js";
import { selectTesseraProviders } from "./serve.js";
import { GithubAppProvider } from "./github-app.js";
import { TesseraError, type AuthorizationBoundary } from "./models.js";

const NOW = Date.parse("2026-11-22T12:00:00Z");
let dir: string;
let tokenFile: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "tessera-optoken-"));
  tokenFile = join(dir, "github-token");
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeToken(token: string): Promise<void> {
  await writeFile(tokenFile, token + "\n", { mode: 0o600 });
  await chmod(tokenFile, 0o600);
}

/** GitHub /user fake keyed by bearer token. */
function github(users: Record<string, [number, unknown] | Error>) {
  return vi.fn<typeof fetch>(async (url, init) => {
    expect(String(url)).toBe("https://api.github.com/user");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    const token = new Headers(init?.headers).get("authorization")?.replace(/^Bearer /, "") ?? "";
    const r = users[token];
    if (!r) throw new Error("unexpected token");
    if (r instanceof Error) throw r;
    return new Response(JSON.stringify(r[1]), { status: r[0] });
  });
}

const octo = { login: "octo", id: 42, name: "Octo Cat", email: "octo@example.com" };

function source(fetchImpl: typeof fetch) {
  return new OperatorTokenSource({ tokenFile, fetchImpl, now: () => NOW });
}

describe("OperatorTokenSource / OperatorTokenProvider", () => {
  it("validates via GET /user and issues the token for the requested repo with a nominal 1h horizon", async () => {
    await writeToken("tok-1");
    const app = new OperatorTokenProvider("app", source(github({ "tok-1": [200, octo] })));
    await app.start();
    expect(app.status()).toMatchObject({ provider: "github-app", state: "ok", login: "octo", last_error: null });
    const result = await app.issue({ identity: "app", repo: "acme/widgets", access: "write" });
    expect(result).toEqual({
      token: "tok-1", expiresAt: new Date(NOW + OPERATOR_TOKEN_HORIZON_MS).toISOString(),
      identity: "octo", commitIdentity: { name: "Octo Cat", email: "octo@example.com" },
      access: "write", repo: "acme/widgets", cache: "n/a",
    });
  });

  it("falls back to <login> and the noreply email when /user has no name/email", async () => {
    await writeToken("tok-1");
    const app = new OperatorTokenProvider("app", source(github({ "tok-1": [200, { login: "octo", id: 42, name: null, email: null }] })));
    await app.start();
    const result = await app.issue({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(result.commitIdentity).toEqual({ name: "octo", email: "42+octo@users.noreply.github.com" });
  });

  it("serves the user slot with no repo or commit identity (the wire contract for user grants)", async () => {
    await writeToken("tok-1");
    const user = new OperatorTokenProvider("user", source(github({ "tok-1": [200, octo] })));
    await user.start();
    expect(await user.issue({ identity: "user", access: "write" })).toMatchObject({
      token: "tok-1", identity: "octo", expiresAt: null, commitIdentity: null, repo: null,
    });
  });

  it("a 401 from GitHub marks the credential invalid and refuses issuance", async () => {
    await writeToken("bad");
    const app = new OperatorTokenProvider("app", source(github({ bad: [401, { message: "Bad credentials" }] })));
    await app.start();
    expect(app.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid", login: null });
    await expect(app.issue({ identity: "app", repo: "acme/widgets", access: "read" })).rejects.toMatchObject({ code: "credential_invalid" });
  });

  it("a network failure is degraded (provider_unavailable) and recovers on the next request", async () => {
    await writeToken("tok-1");
    let down = true;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (down) throw new TypeError("fetch failed");
      return new Response(JSON.stringify(octo), { status: 200 });
    });
    const app = new OperatorTokenProvider("app", source(fetchImpl));
    await app.start();
    expect(app.status()).toMatchObject({ state: "degraded", last_error: "provider_unavailable" });
    await expect(app.issue({ identity: "app", repo: "acme/widgets", access: "read" })).rejects.toMatchObject({ code: "provider_unavailable" });
    down = false;
    expect((await app.issue({ identity: "app", repo: "acme/widgets", access: "read" })).token).toBe("tok-1");
    expect(app.status().state).toBe("ok");
  });

  it("re-reads the file when it changes, so rotation needs no restart", async () => {
    await writeToken("tok-1");
    const fetchImpl = github({ "tok-1": [200, octo], "tok-2": [200, { ...octo, login: "octo2" }] });
    const app = new OperatorTokenProvider("app", source(fetchImpl));
    await app.start();
    const revision = app.status().credentialRevision;
    await writeToken("tok-2");
    const result = await app.issue({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(result).toMatchObject({ token: "tok-2", identity: "octo2" });
    expect(app.status().credentialRevision).not.toBe(revision);
    // An unchanged file is not revalidated on every request.
    const calls = fetchImpl.mock.calls.length;
    await app.issue({ identity: "app", repo: "acme/widgets", access: "read" });
    expect(fetchImpl.mock.calls.length).toBe(calls);
    // refresh forces a revalidation.
    await app.issue({ identity: "app", repo: "acme/widgets", access: "read", refresh: true });
    expect(fetchImpl.mock.calls.length).toBe(calls + 1);
  });

  it("a missing file is unconfigured; a group/world-readable file is refused", async () => {
    const app = new OperatorTokenProvider("app", source(github({})));
    await app.start();
    expect(app.status()).toMatchObject({ state: "unconfigured", last_error: null });
    await expect(app.issue({ identity: "app", repo: "acme/widgets", access: "read" })).rejects.toMatchObject({ code: "provider_unconfigured" });
    await writeFile(tokenFile, "tok-1", { mode: 0o644 });
    await chmod(tokenFile, 0o644);
    await app.start();
    expect(app.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
  });

  it("rejects an app request without a repo and a mismatched identity", async () => {
    await writeToken("tok-1");
    const app = new OperatorTokenProvider("app", source(github({ "tok-1": [200, octo] })));
    await app.start();
    await expect(app.issue({ identity: "app", access: "read" })).rejects.toBeInstanceOf(TesseraError);
    await expect(app.issue({ identity: "user", access: "read" })).rejects.toMatchObject({ code: "invalid_request" });
  });
});

describe("OperatorTokenSource freshness", () => {
  it("a forced load that joins an ordinary in-flight load still revalidates", async () => {
    await writeToken("tok-1");
    const fetchImpl = github({ "tok-1": [200, octo] });
    const src = source(fetchImpl);
    await src.load(true);
    const calls = fetchImpl.mock.calls.length;
    // An ordinary load of an unchanged, healthy token skips validation; a forced
    // caller arriving while it is in flight must not settle for that.
    const ordinary = src.load(false);
    const forced = src.load(true);
    await Promise.all([ordinary, forced]);
    expect(fetchImpl.mock.calls.length).toBe(calls + 1);
  });

  it("a forced retry after revocation sees the revoked token, not the stale ok", async () => {
    await writeToken("tok-1");
    let revoked = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      revoked ? new Response("{}", { status: 401 }) : new Response(JSON.stringify(octo), { status: 200 }));
    const src = source(fetchImpl);
    await src.load(true);
    revoked = true;
    const ordinary = src.load(false);
    await expect(src.current(true)).rejects.toMatchObject({ code: "credential_invalid" });
    await ordinary;
  });

  it("revalidates an unchanged token once it is older than the revalidation bound", async () => {
    await writeToken("tok-1");
    let now = NOW;
    let revoked = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      revoked ? new Response("{}", { status: 401 }) : new Response(JSON.stringify(octo), { status: 200 }));
    const provider = new OperatorTokenProvider("app", new OperatorTokenSource({ tokenFile, fetchImpl, now: () => now }));
    await provider.start();
    revoked = true;
    now += OPERATOR_TOKEN_REVALIDATE_MS - 1;
    await provider.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(provider.status().state).toBe("ok");
    now += 1;
    await provider.refresh();
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(provider.status()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
  });

  it("reports each transition into a failure state once, with a bounded code", async () => {
    await writeToken("tok-1");
    const codes: string[] = [];
    let mode: "ok" | "401" | "down" = "401";
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (mode === "down") throw new TypeError("fetch failed");
      return mode === "401" ? new Response("{}", { status: 401 }) : new Response(JSON.stringify(octo), { status: 200 });
    });
    const src = new OperatorTokenSource({ tokenFile, fetchImpl, now: () => NOW, onError: (code) => codes.push(code) });
    await src.load(true);
    await src.load(false); // still invalid: no repeat
    expect(codes).toEqual(["credential_invalid"]);
    mode = "down";
    await src.load(true);
    expect(codes).toEqual(["credential_invalid", "provider_unavailable"]);
    mode = "ok";
    await src.load(true);
    await rm(tokenFile);
    await src.load(false);
    await src.load(false);
    expect(codes).toEqual(["credential_invalid", "provider_unavailable", "provider_unconfigured"]);
    expect(codes.join()).not.toContain("tok-1");
  });

  it("Tessera /status reflects a removed token file and a revoked token on the provider-health poll", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(NOW);
    await writeToken("tok-1");
    let revoked = false;
    const fetchImpl = vi.fn<typeof fetch>(async () =>
      revoked ? new Response("{}", { status: 401 }) : new Response(JSON.stringify(octo), { status: 200 }));
    const providers = selectTesseraProviders({}, { TESSERA_GITHUB_TOKEN_FILE: tokenFile }, undefined, fetchImpl);
    await Promise.all(providers.map((p) => p.start()));
    // Record each poll's provider re-check so the test awaits exactly that work.
    let inflight: Promise<void>[] = [];
    for (const p of providers) {
      const refresh = p.refresh!.bind(p);
      p.refresh = () => { const done = refresh(); inflight.push(done); return done; };
    }
    const app = buildTesseraServer({ providers, logger: false });
    const appState = async () => (await app.inject({ method: "GET", url: "/status" })).json().providers[0];
    const poll = async () => {
      vi.advanceTimersByTime(60_000);
      expect(inflight.length).toBeGreaterThan(0);
      await Promise.all(inflight);
      inflight = [];
      // Let the poll's allSettled/finally bookkeeping run before the next tick.
      await new Promise((r) => setImmediate(r));
    };
    try {
      await app.ready();
      expect(await appState()).toMatchObject({ state: "ok" });
      // Revocation upstream: visible once the revalidation bound passes.
      revoked = true;
      for (let t = 0; t < OPERATOR_TOKEN_REVALIDATE_MS; t += 60_000) await poll();
      expect(await appState()).toMatchObject({ state: "invalid", last_error: "credential_invalid" });
      // Token file removed: visible on the next poll.
      revoked = false;
      await writeToken("tok-2");
      await poll();
      expect(await appState()).toMatchObject({ state: "ok" });
      await rm(tokenFile);
      await poll();
      expect(await appState()).toMatchObject({ state: "unconfigured" });
    } finally {
      await app.close();
      vi.useRealTimers();
    }
  });
});

describe("selectTesseraProviders", () => {
  it("uses the GitHub App when configured, the operator token otherwise", () => {
    const withApp = selectTesseraProviders({ appId: "9", privateKey: "pem" }, { TESSERA_GITHUB_TOKEN_FILE: tokenFile });
    expect(withApp[0]).toBeInstanceOf(GithubAppProvider);
    expect(withApp.map((p) => p.identity)).toEqual(["app", "user"]);
    const tokenOnly = selectTesseraProviders({}, { TESSERA_GITHUB_TOKEN_FILE: tokenFile });
    expect(tokenOnly.map((p) => [p.constructor.name, p.identity])).toEqual([
      ["OperatorTokenProvider", "app"], ["OperatorTokenProvider", "user"],
    ]);
    const neither = selectTesseraProviders({}, {});
    expect(neither).toHaveLength(1);
    expect(neither[0]).toBeInstanceOf(GithubAppProvider);
    expect(neither[0].status().state).toBe("unconfigured");
  });
});

describe("selectTesseraProviders operator-token error reporting", () => {
  it("passes the operator-token error callback through; startup still resolves (liveness)", async () => {
    await writeToken("tok-1");
    const codes: string[] = [];
    const providers = selectTesseraProviders({}, { TESSERA_GITHUB_TOKEN_FILE: tokenFile }, undefined,
      github({ "tok-1": [401, {}] }), (code) => codes.push(code));
    await expect(Promise.all(providers.map((p) => p.start()))).resolves.toBeDefined();
    expect(codes).toEqual(["credential_invalid"]); // both slots share one source: reported once
  });
});

describe("operator token through the Tessera server (auth + policy still gate it)", () => {
  const authorize: AuthorizationBoundary = {
    authenticate: (header) => {
      if (header === "Bearer hatchery-key") return "hatchery";
      throw new TesseraError("unauthorized");
    },
    authorize: (caller, request) => {
      if (caller !== "hatchery" || request.identity !== "app" || request.access !== "read" || request.repo !== "acme/widgets") {
        throw new TesseraError("policy_denied");
      }
    },
  };

  it("issues to an authorized caller, denies unauthenticated and out-of-policy requests, and reports status", async () => {
    await writeToken("tok-1");
    const providers = selectTesseraProviders({}, { TESSERA_GITHUB_TOKEN_FILE: tokenFile }, undefined, github({ "tok-1": [200, octo] }));
    await Promise.all(providers.map((p) => p.start()));
    const app = buildTesseraServer({ providers, authorize, logger: false });
    try {
      const ok = await app.inject({
        method: "POST", url: "/v1/github/token", headers: { authorization: "Bearer hatchery-key" },
        payload: { identity: "app", repo: "acme/widgets", access: "read" },
      });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toMatchObject({ token: "tok-1", identity: "octo", repo: "acme/widgets", access: "read",
        commit_identity: { name: "Octo Cat", email: "octo@example.com" } });
      const anon = await app.inject({ method: "POST", url: "/v1/github/token", payload: { identity: "app", repo: "acme/widgets", access: "read" } });
      expect(anon.statusCode).toBe(401);
      const denied = await app.inject({
        method: "POST", url: "/v1/github/token", headers: { authorization: "Bearer hatchery-key" },
        payload: { identity: "app", repo: "acme/widgets", access: "write" },
      });
      expect(denied.statusCode).toBe(403);
      expect(denied.body).not.toContain("tok-1");
      const status = await app.inject({ method: "GET", url: "/status" });
      expect(status.json().providers).toEqual([
        expect.objectContaining({ provider: "github-app", state: "ok", login: "octo" }),
        expect.objectContaining({ provider: "github-user", state: "ok", login: "octo" }),
      ]);
      expect(status.body).not.toContain("tok-1");
    } finally {
      await app.close();
    }
  });
});
