/**
 * @l1 @deterministic @ci
 *
 * `getGitHubToken` and its gated environment fallback, against an injected
 * fake `fetch` (no network). The fallback counter is mocked so each test can
 * assert exactly how many times it fired.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../observability/tessera-metrics.js", () => ({
  recordTesseraClientFallback: vi.fn(),
}));

import { recordTesseraClientFallback } from "../observability/tessera-metrics.js";
import {
  getGitHubToken,
  type GetGitHubTokenOptions,
  type GitHubTokenRequest,
  resetDefaultTesseraClientForTests,
  TesseraClient,
  TesseraClientError,
  type TesseraClientErrorCode,
} from "./client.js";
import { TESSERA_GH_TOKEN_FALLBACK_ENV } from "./config.js";

const CLIENT_KEY = "tessera-fallback-test-key-do-not-leak";
const TESSERA_TOKEN = "ghs_FROMTESSERA0123456789";
const ENV_TOKEN = "ghp_ENVFALLBACKSECRET0123456789";
const OTHER_ENV_TOKEN = "ghp_GITHUBTOKENSECRET0123456789";
const BASE_URL = "http://tessera.test:9477";

const WIRE = {
  token: TESSERA_TOKEN,
  expires_at: "2099-01-01T00:00:00Z",
  identity: "march-bot[bot]",
  commit_identity: { name: "march-bot[bot]", email: "1+march-bot[bot]@users.noreply.github.com" },
  access: "write",
  repo: "acme/widgets",
};

const APP_WRITE: GitHubTokenRequest = { identity: "app", repo: "acme/widgets", access: "write" };
const USER_WRITE: GitHubTokenRequest = { identity: "user", access: "write" };

const STATUS: Record<string, number> = {
  unauthorized: 401,
  policy_denied: 403,
  invalid_request: 400,
  repo_not_installed: 404,
  provider_unconfigured: 503,
  credential_invalid: 502,
  provider_unavailable: 503,
  mint_failed: 502,
  internal: 500,
};

const ALLOWED: readonly TesseraClientErrorCode[] = [
  "unreachable",
  "client_key_missing",
  "provider_unavailable",
  "provider_unconfigured",
  "credential_invalid",
  "mint_failed",
  "internal",
];

const DENIED: readonly TesseraClientErrorCode[] = [
  "unauthorized",
  "policy_denied",
  "invalid_request",
  "repo_not_installed",
];

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fake `fetch` that answers with the given server code, or the entitlement. */
function serverFetch(code?: string) {
  return vi.fn<typeof fetch>(async () => {
    if (code === undefined) return jsonResponse(WIRE);
    if (code === "unreachable") throw new TypeError("fetch failed");
    return jsonResponse({ error: { code, message: `server said ${code}` } }, STATUS[code] ?? 500);
  });
}

/** A client that fails with `code` (or succeeds when undefined). */
function failingClient(code?: TesseraClientErrorCode) {
  if (code === "client_key_missing") {
    return new TesseraClient({ baseUrl: BASE_URL, env: {}, fetchImpl: serverFetch() });
  }
  return new TesseraClient({
    baseUrl: BASE_URL,
    clientKey: CLIENT_KEY,
    env: {},
    fetchImpl: serverFetch(code),
  });
}

function fakeLogger() {
  return { warn: vi.fn<(obj: Record<string, unknown>, msg: string) => void>() };
}

/**
 * An env whose GitHub token keys throw on any access, so a test fails if the
 * token variables are read at all.
 */
function guardedEnv(base: NodeJS.ProcessEnv): { env: NodeJS.ProcessEnv; reads: string[] } {
  const reads: string[] = [];
  const env = new Proxy(base, {
    get(target, prop, receiver) {
      if (prop === "GH_TOKEN" || prop === "GITHUB_TOKEN") {
        reads.push(prop);
        throw new Error(`env token ${prop} must not be read`);
      }
      return Reflect.get(target, prop, receiver);
    },
    has(target, prop) {
      if (prop === "GH_TOKEN" || prop === "GITHUB_TOKEN") {
        reads.push(prop);
        throw new Error(`env token ${prop} must not be probed`);
      }
      return Reflect.has(target, prop);
    },
  });
  return { env, reads };
}

const FLAG_ON = { [TESSERA_GH_TOKEN_FALLBACK_ENV]: "1" };

async function captureError(promise: Promise<unknown>): Promise<TesseraClientError> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(TesseraClientError);
    const typed = err as TesseraClientError;
    expect(typed.message).not.toContain(ENV_TOKEN);
    expect(typed.message).not.toContain(CLIENT_KEY);
    return typed;
  }
  throw new Error("expected the call to reject");
}

const recordFallback = vi.mocked(recordTesseraClientFallback);

beforeEach(() => {
  recordFallback.mockClear();
});

afterEach(() => {
  resetDefaultTesseraClientForTests();
  vi.unstubAllGlobals();
});

describe("getGitHubToken", () => {
  it("returns a Tessera entitlement and records nothing on success", async () => {
    const logger = fakeLogger();
    const result = await getGitHubToken(APP_WRITE, {
      client: failingClient(),
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
      logger,
    });
    expect(result.token).toBe(TESSERA_TOKEN);
    expect(result.source).toBe("tessera");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it.each(ALLOWED)("falls back to the env token on %s when the flag is set", async (code) => {
    const logger = fakeLogger();
    const result = await getGitHubToken(APP_WRITE, {
      client: failingClient(code),
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
      logger,
      service: "march-herald",
    });
    expect(result).toEqual({
      token: ENV_TOKEN,
      expiresAt: null,
      identity: "",
      commitIdentity: null,
      source: "env-fallback",
    });
    expect(Object.isFrozen(result)).toBe(true);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [fields, msg] = logger.warn.mock.calls[0]!;
    expect(fields).toEqual({ reason: code, identity: "app", service: "march-herald" });
    expect(JSON.stringify(fields)).not.toContain(ENV_TOKEN);
    expect(msg).not.toContain(ENV_TOKEN);
    expect(recordFallback).toHaveBeenCalledTimes(1);
    expect(recordFallback).toHaveBeenCalledWith({ service: "march-herald" });
  });

  it.each(DENIED)("never falls back on %s", async (code) => {
    const logger = fakeLogger();
    const err = await captureError(
      getGitHubToken(APP_WRITE, {
        client: failingClient(code),
        env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
        logger,
      }),
    );
    expect(err.code).toBe(code);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it("never falls back on an error that is not a TesseraClientError", async () => {
    const client = failingClient();
    vi.spyOn(client, "issueGitHubToken").mockRejectedValue(new Error("boom"));
    await expect(
      getGitHubToken(APP_WRITE, {
        client,
        env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
        logger: fakeLogger(),
      }),
    ).rejects.toThrow("boom");
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it("never falls back for the user identity and never reads the env token for it", async () => {
    const { env, reads } = guardedEnv({ ...FLAG_ON });
    const logger = fakeLogger();
    const err = await captureError(
      getGitHubToken(USER_WRITE, { client: failingClient("unreachable"), env, logger }),
    );
    expect(err.code).toBe("unreachable");
    expect(reads).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["unset", {}],
    ['"0"', { [TESSERA_GH_TOKEN_FALLBACK_ENV]: "0" }],
    ['"true"', { [TESSERA_GH_TOKEN_FALLBACK_ENV]: "true" }],
  ])("with the flag %s, never reads the env token and surfaces the typed error", async (_l, base) => {
    for (const code of ALLOWED) {
      const { env, reads } = guardedEnv({ ...base });
      const logger = fakeLogger();
      const err = await captureError(
        getGitHubToken(APP_WRITE, { client: failingClient(code), env, logger }),
      );
      expect(err.code).toBe(code);
      expect(reads).toEqual([]);
      expect(logger.warn).not.toHaveBeenCalled();
    }
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it.each([
    ["absent", {}],
    ["blank", { GH_TOKEN: "  ", GITHUB_TOKEN: "" }],
  ])("rethrows the original error when the env token is %s", async (_l, tokens) => {
    const logger = fakeLogger();
    const err = await captureError(
      getGitHubToken(APP_WRITE, {
        client: failingClient("provider_unavailable"),
        env: { ...FLAG_ON, ...tokens },
        logger,
      }),
    );
    expect(err.code).toBe("provider_unavailable");
    expect(err.status).toBe(503);
    expect(err.message).toBe("server said provider_unavailable");
    expect(logger.warn).not.toHaveBeenCalled();
    expect(recordFallback).not.toHaveBeenCalled();
  });

  it("prefers GH_TOKEN over GITHUB_TOKEN and uses GITHUB_TOKEN alone", async () => {
    const both = await getGitHubToken(APP_WRITE, {
      client: failingClient("unreachable"),
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN, GITHUB_TOKEN: OTHER_ENV_TOKEN },
      logger: fakeLogger(),
    });
    expect(both.token).toBe(ENV_TOKEN);
    const only = await getGitHubToken(APP_WRITE, {
      client: failingClient("unreachable"),
      env: { ...FLAG_ON, GITHUB_TOKEN: OTHER_ENV_TOKEN },
      logger: fakeLogger(),
    });
    expect(only.token).toBe(OTHER_ENV_TOKEN);
  });

  it("labels the counter from MARCH_OTEL_SERVICE_NAME, else unknown", async () => {
    await getGitHubToken(APP_WRITE, {
      client: failingClient("unreachable"),
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN, MARCH_OTEL_SERVICE_NAME: "march-brood" },
      logger: fakeLogger(),
    });
    await getGitHubToken(APP_WRITE, {
      client: failingClient("unreachable"),
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
      logger: fakeLogger(),
    });
    expect(recordFallback.mock.calls).toEqual([[{ service: "march-brood" }], [{ service: "unknown" }]]);
  });

  it("never caches a fallback result: a later call asks Tessera again", async () => {
    let up = false;
    const fetchImpl = vi.fn<typeof fetch>(async () => {
      if (!up) throw new TypeError("fetch failed");
      return jsonResponse(WIRE);
    });
    const client = new TesseraClient({ baseUrl: BASE_URL, clientKey: CLIENT_KEY, env: {}, fetchImpl });
    const options: GetGitHubTokenOptions = {
      client,
      env: { ...FLAG_ON, GH_TOKEN: ENV_TOKEN },
      logger: fakeLogger(),
    };

    expect((await getGitHubToken(APP_WRITE, options)).source).toBe("env-fallback");
    expect((await getGitHubToken(APP_WRITE, options)).source).toBe("env-fallback");
    expect(fetchImpl).toHaveBeenCalledTimes(2);

    up = true;
    const served = await getGitHubToken(APP_WRITE, options);
    expect(served.source).toBe("tessera");
    expect(served.token).toBe(TESSERA_TOKEN);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("shares one lazily created default client, and its cache, across calls", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => jsonResponse(WIRE));
    vi.stubGlobal("fetch", fetchImpl);
    const env = { MARCH_TESSERA_URL: BASE_URL, MARCH_TESSERA_CLIENT_KEY: CLIENT_KEY };

    const first = await getGitHubToken(APP_WRITE, { env });
    const second = await getGitHubToken(APP_WRITE, { env });
    expect(first.source).toBe("tessera");
    expect(second).toBe(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(`${BASE_URL}/v1/github/token`);

    resetDefaultTesseraClientForTests();
    await getGitHubToken(APP_WRITE, { env });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});
