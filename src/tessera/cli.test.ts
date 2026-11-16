/**
 * @l1 @deterministic @ci
 *
 * `march tessera token` logic: validation before any request, stdout carrying
 * only the token, one-line fixed-text failures on stderr, and no fallback to
 * host credentials. Uses an injected fake `fetch`; no network.
 */
import { describe, expect, it } from "vitest";
import { TesseraClient, TesseraClientError } from "./client.js";
import { runTesseraTokenCommand, tokenFailureMessage } from "./cli.js";
import { ERROR, SUCCESS, USAGE_ERROR } from "../shared/exit-codes.js";

const TOKEN = "ghs_secretTokenValue123";
const CLIENT_KEY = "client-key-very-secret-abc";
const FORBIDDEN_KEYS = ["GH_TOKEN", "GITHUB_TOKEN", "MARCH_TESSERA_GH_TOKEN_FALLBACK"];

interface FakeCall {
  url: string;
  init: RequestInit;
}

function entitlementResponse(): Response {
  return new Response(
    JSON.stringify({
      token: TOKEN,
      expires_at: "2099-01-01T00:00:00Z",
      identity: "march-bot[bot]",
      commit_identity: { name: "march-bot[bot]", email: "1+march-bot[bot]@users.noreply.github.com" },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function errorResponse(code: string, status: number, headers: Record<string, string> = {}): Response {
  return new Response(
    JSON.stringify({ error: { code, message: `server says ${TOKEN} ${CLIENT_KEY}` } }),
    { status, headers: { "content-type": "application/json", ...headers } },
  );
}

function fakeFetch(respond: () => Response | Promise<Response>): {
  fetchImpl: typeof fetch;
  calls: FakeCall[];
} {
  const calls: FakeCall[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetchImpl, calls };
}

/** An env that throws if any host-credential or fallback variable is read. */
function guardedEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  return new Proxy({ ...values } as NodeJS.ProcessEnv, {
    get(target, prop) {
      if (typeof prop === "string" && FORBIDDEN_KEYS.includes(prop)) {
        throw new Error(`env.${prop} was read`);
      }
      return Reflect.get(target, prop);
    },
    has(target, prop) {
      if (typeof prop === "string" && FORBIDDEN_KEYS.includes(prop)) {
        throw new Error(`env.${prop} was probed`);
      }
      return Reflect.has(target, prop);
    },
  });
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    stdout: (text: string) => out.push(text),
    stderr: (text: string) => err.push(text),
  };
}

function clientWith(fetchImpl: typeof fetch): TesseraClient {
  return new TesseraClient({ baseUrl: "http://tessera.test", clientKey: CLIENT_KEY, fetchImpl });
}

describe("runTesseraTokenCommand", () => {
  it("writes exactly the token and a newline to stdout and exits SUCCESS", async () => {
    const { fetchImpl, calls } = fakeFetch(entitlementResponse);
    const io = capture();
    const code = await runTesseraTokenCommand({
      repo: "acme/widgets",
      access: "write",
      client: clientWith(fetchImpl),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(SUCCESS);
    expect(io.out.join("")).toBe(`${TOKEN}\n`);
    expect(io.err).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      identity: "app",
      repo: "acme/widgets",
      access: "write",
    });
  });

  it("accepts an explicit --identity app", async () => {
    const { fetchImpl } = fakeFetch(entitlementResponse);
    const io = capture();
    const code = await runTesseraTokenCommand({
      repo: "acme/widgets",
      access: "read",
      identity: "app",
      client: clientWith(fetchImpl),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(SUCCESS);
    expect(io.out.join("")).toBe(`${TOKEN}\n`);
  });

  it("builds its client from env and never reads the fallback flag, GH_TOKEN or GITHUB_TOKEN", async () => {
    // Success through an env-built client: the guarded env must not be probed.
    const ok = fakeFetch(entitlementResponse);
    const okIo = capture();
    const okEnv = guardedEnv({
      MARCH_TESSERA_URL: "http://tessera.test",
      MARCH_TESSERA_CLIENT_KEY: CLIENT_KEY,
    });
    expect(
      await runTesseraTokenCommand({
        repo: "acme/widgets",
        access: "write",
        env: okEnv,
        fetchImpl: ok.fetchImpl,
        stdout: okIo.stdout,
        stderr: okIo.stderr,
      }),
    ).toBe(SUCCESS);
    expect(okIo.out.join("")).toBe(`${TOKEN}\n`);
    expect(ok.calls[0]!.url).toBe("http://tessera.test/v1/github/token");

    // A fallback-eligible failure (unreachable) still never consults the env tokens.
    const down = fakeFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const downIo = capture();
    expect(
      await runTesseraTokenCommand({
        repo: "acme/widgets",
        access: "write",
        env: okEnv,
        fetchImpl: down.fetchImpl,
        stdout: downIo.stdout,
        stderr: downIo.stderr,
      }),
    ).toBe(ERROR);
    expect(downIo.out).toEqual([]);

    // A missing client key (also fallback-eligible) likewise.
    const noKeyIo = capture();
    const noKey = fakeFetch(entitlementResponse);
    expect(
      await runTesseraTokenCommand({
        repo: "acme/widgets",
        access: "write",
        env: guardedEnv({ MARCH_TESSERA_URL: "http://tessera.test" }),
        fetchImpl: noKey.fetchImpl,
        stdout: noKeyIo.stdout,
        stderr: noKeyIo.stderr,
      }),
    ).toBe(ERROR);
    expect(noKey.calls).toHaveLength(0);
    expect(noKeyIo.err.join("")).toContain("MARCH_TESSERA_CLIENT_KEY");
  });

  it("ignores the fallback flag even when GH_TOKEN is set", async () => {
    const down = fakeFetch(() => Promise.reject(new Error("down")));
    const io = capture();
    const code = await runTesseraTokenCommand({
      repo: "acme/widgets",
      access: "write",
      env: {
        MARCH_TESSERA_URL: "http://tessera.test",
        MARCH_TESSERA_CLIENT_KEY: CLIENT_KEY,
        MARCH_TESSERA_GH_TOKEN_FALLBACK: "1",
        GH_TOKEN: "gho_hostToken",
        GITHUB_TOKEN: "gho_hostToken2",
      },
      fetchImpl: down.fetchImpl,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(ERROR);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).not.toContain("gho_hostToken");
  });

  const failures: Array<{
    name: string;
    code: string;
    respond: () => Response | Promise<Response>;
    expectText?: RegExp;
  }> = [
    { name: "unauthorized", code: "unauthorized", respond: () => errorResponse("unauthorized", 401) },
    { name: "policy_denied", code: "policy_denied", respond: () => errorResponse("policy_denied", 403) },
    {
      name: "provider_unconfigured",
      code: "provider_unconfigured",
      respond: () => errorResponse("provider_unconfigured", 503),
    },
    {
      name: "provider_unavailable with Retry-After",
      code: "provider_unavailable",
      respond: () => errorResponse("provider_unavailable", 503, { "retry-after": "30" }),
      expectText: /30s/,
    },
    {
      name: "repo_not_installed",
      code: "repo_not_installed",
      respond: () => errorResponse("repo_not_installed", 404),
    },
    { name: "mint_failed", code: "mint_failed", respond: () => errorResponse("mint_failed", 502) },
    { name: "internal", code: "internal", respond: () => errorResponse("internal", 500) },
    {
      name: "unreachable (network error)",
      code: "unreachable",
      respond: () => Promise.reject(new Error(`boom ${CLIENT_KEY}`)),
    },
    {
      name: "unreachable (malformed body)",
      code: "unreachable",
      respond: () => new Response("not json", { status: 200 }),
    },
  ];

  for (const failure of failures) {
    it(`reports ${failure.name} as one stderr line, empty stdout, exit ERROR`, async () => {
      const { fetchImpl } = fakeFetch(failure.respond);
      const io = capture();
      const code = await runTesseraTokenCommand({
        repo: "acme/widgets",
        access: "write",
        client: clientWith(fetchImpl),
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(ERROR);
      expect(io.out).toEqual([]);
      const stderr = io.err.join("");
      expect(stderr).toMatch(/^march tessera token: [^\n]+\n$/);
      expect(stderr).toContain(`(${failure.code}`);
      expect(stderr).not.toContain(TOKEN);
      expect(stderr).not.toContain(CLIENT_KEY);
      if (failure.expectText) expect(stderr).toMatch(failure.expectText);
    });
  }

  const badTokens: Array<{ name: string; token: string }> = [
    { name: "a newline", token: "ghs_abc\nexport EVIL=1" },
    { name: "a space", token: "ghs_abc def" },
    { name: "a NUL", token: "ghs_abc\u0000def" },
  ];
  for (const bad of badTokens) {
    it(`rejects a token containing ${bad.name} as an invalid answer without echoing it`, async () => {
      const { fetchImpl } = fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              token: bad.token,
              expires_at: "2099-01-01T00:00:00Z",
              identity: "march-bot[bot]",
              commit_identity: { name: "march-bot[bot]", email: "1+march-bot[bot]@users.noreply.github.com" },
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          ),
      );
      const io = capture();
      const code = await runTesseraTokenCommand({
        repo: "acme/widgets",
        access: "write",
        client: clientWith(fetchImpl),
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(ERROR);
      expect(io.out).toEqual([]);
      const stderr = io.err.join("");
      expect(stderr).toBe(
        "march tessera token: Tessera could not be reached or gave an invalid answer (unreachable)\n",
      );
      expect(stderr).not.toContain("ghs_abc");
    });
  }

  it("reports a missing client key naming MARCH_TESSERA_CLIENT_KEY", async () => {
    const { fetchImpl, calls } = fakeFetch(entitlementResponse);
    const io = capture();
    const code = await runTesseraTokenCommand({
      repo: "acme/widgets",
      access: "write",
      client: new TesseraClient({ baseUrl: "http://tessera.test", env: {}, fetchImpl }),
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(ERROR);
    expect(calls).toHaveLength(0);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/^march tessera token: .*MARCH_TESSERA_CLIENT_KEY.*\(client_key_missing\)\n$/);
  });

  it("reports an unexpected error generically without echoing it", async () => {
    const client = {
      issueGitHubToken: async () => {
        throw new Error(`weird ${TOKEN}`);
      },
    } as unknown as TesseraClient;
    const io = capture();
    const code = await runTesseraTokenCommand({
      repo: "acme/widgets",
      access: "write",
      client,
      stdout: io.stdout,
      stderr: io.stderr,
    });
    expect(code).toBe(ERROR);
    expect(io.out).toEqual([]);
    expect(io.err.join("")).toMatch(/^march tessera token: [^\n]+\n$/);
    expect(io.err.join("")).not.toContain(TOKEN);
  });

  const usageCases: Array<{ name: string; repo?: string; access?: string; identity?: string; text: RegExp }> = [
    { name: "missing --repo", access: "write", text: /--repo/ },
    { name: "invalid --repo", repo: "not-a-repo", access: "write", text: /--repo/ },
    { name: "dot-only repo segment", repo: "acme/..", access: "write", text: /--repo/ },
    { name: "missing --access", repo: "acme/widgets", text: /--access/ },
    { name: "invalid --access", repo: "acme/widgets", access: "admin", text: /--access/ },
    { name: "--identity user", repo: "acme/widgets", access: "write", identity: "user", text: /--identity/ },
    { name: "--identity bogus", repo: "acme/widgets", access: "write", identity: "bot", text: /--identity/ },
  ];

  for (const usage of usageCases) {
    it(`treats ${usage.name} as a usage error before any request`, async () => {
      const { fetchImpl, calls } = fakeFetch(entitlementResponse);
      const io = capture();
      const code = await runTesseraTokenCommand({
        ...(usage.repo !== undefined ? { repo: usage.repo } : {}),
        ...(usage.access !== undefined ? { access: usage.access } : {}),
        ...(usage.identity !== undefined ? { identity: usage.identity } : {}),
        client: clientWith(fetchImpl),
        stdout: io.stdout,
        stderr: io.stderr,
      });
      expect(code).toBe(USAGE_ERROR);
      expect(calls).toHaveLength(0);
      expect(io.out).toEqual([]);
      expect(io.err.join("")).toMatch(/^march tessera token: [^\n]+\n$/);
      expect(io.err.join("")).toMatch(usage.text);
    });
  }
});

describe("tokenFailureMessage", () => {
  it("never echoes the server's message", () => {
    const message = tokenFailureMessage(
      new TesseraClientError("policy_denied", `leak ${TOKEN}`, { status: 403 }),
    );
    expect(message).not.toContain(TOKEN);
    expect(message).toContain("(policy_denied)");
  });

  it("includes the retry delay for provider_unavailable only when known", () => {
    expect(
      tokenFailureMessage(new TesseraClientError("provider_unavailable", "x", { retryAfterSeconds: 12 })),
    ).toContain("retry after 12s");
    expect(tokenFailureMessage(new TesseraClientError("provider_unavailable", "x"))).not.toContain(
      "retry after",
    );
  });
});
