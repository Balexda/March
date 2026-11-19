/**
 * @l1 @deterministic @ci
 */
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createServer, type RequestListener } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const exec = promisify(execFile);
const cli = resolve(import.meta.dirname, "../../dist/cli.js");
const args = ["--repo", "acme/widgets", "--access", "write"];
const ambient = "ambient-credential";
const key = "fake-client-key";
const token = "issued-token";
const entitlement = {
  token,
  identity: "test-bot[bot]",
  repo: "acme/widgets",
  access: "write",
  expires_at: "2030-01-01T00:00:00Z",
  commit_identity: { name: "Test Bot", email: "bot@example.com" },
};

describe("march tessera token", () => {
  const server = createServer();
  let url: string;

  async function listen(handler: RequestListener): Promise<void> {
    server.once("request", handler);
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  afterEach(async () => {
    server.removeAllListeners("request");
    const closed = new Promise<void>((done) => server.close(() => done()));
    server.closeAllConnections();
    await closed;
    url = "";
  });

  async function run(options = args, clientKey = key) {
    try {
      const result = await exec(process.execPath, [cli, "tessera", "token", ...options], {
        timeout: 20_000,
        env: {
          ...process.env,
          MARCH_OTEL: "0",
          MARCH_TESSERA_URL: url,
          MARCH_TESSERA_CLIENT_KEY: clientKey,
          MARCH_TESSERA_GH_TOKEN_FALLBACK: "1",
          GH_TOKEN: ambient,
          GITHUB_TOKEN: ambient,
        },
      });
      return { ...result, code: 0 };
    } catch (error) {
      const result = error as { stdout: string; stderr: string; code: number };
      // A test subprocess timeout or spawn failure must fail the test.
      if (typeof result.code !== "number") throw error;
      return { stdout: result.stdout, stderr: result.stderr, code: result.code };
    }
  }

  it.each([{ identity: [] }, { identity: ["--identity", "app"] }])(
    "prints the issued token with identity options $identity", async ({ identity }) => {
    const requests: unknown[] = [];
    await listen(async (request, response) => {
      let body = "";
      for await (const part of request) body += part;
      requests.push([request.method, request.url, request.headers.authorization, JSON.parse(body)]);
      response.end(JSON.stringify(entitlement));
    });
    expect(await run([...args, ...identity])).toEqual({ stdout: token + "\n", stderr: "", code: 0 });
    expect(requests).toEqual([
      ["POST", "/v1/github/token", `Bearer ${key}`, { repo: "acme/widgets", access: "write", identity: "app" }],
    ]);
  });

  it.each([
    [],
    ["--repo", "invalid", "--access", "write"],
    ["--repo", "acme/widgets", "--access", "admin"],
    [...args, "--identity", "user"],
    [...args, `--${ambient}`],
  ].map(options => ({ options })))("rejects invalid arguments before issuance ($options)", async ({ options }) => {
    let requests = 0;
    await listen((_request, response) => {
      requests++;
      response.end(JSON.stringify(entitlement));
    });
    const result = await run(options);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toMatch(/^Usage: march tessera token/);
    expect(result.stderr).not.toContain(ambient);
    expect(requests).toBe(0);
  });

  it.each([
    { status: 403, body: { error: { code: "policy_denied", message: key } }, code: "policy_denied" },
    { status: 200, body: { token: key }, code: "invalid_response" },
    { status: 200, body: { ...entitlement, token: key + "\n" + ambient }, code: "invalid_response" },
  ])("fails closed with $code (HTTP $status)", async ({ status, body, code }) => {
    await listen((_request, response) => {
      response.writeHead(status);
      response.end(JSON.stringify(body));
    });
    expect(await run()).toEqual({ stdout: "", stderr: `Tessera token request failed (${code}).\n`, code: 1 });
  });

  it("fails closed when configuration is missing", async () => {
    expect(await run(args, "")).toEqual({
      stdout: "", stderr: "Tessera token request failed (unconfigured).\n", code: 1,
    });
  });

  it("fails closed when the response body stalls", async () => {
    await listen((_request, response) => {
      response.writeHead(200);
      response.write("{");
    });
    expect(await run()).toEqual({
      stdout: "", stderr: "Tessera token request failed (unreachable).\n", code: 1,
    });
  }, 22_000);
});
