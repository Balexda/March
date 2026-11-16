/**
 * @l1 @deterministic @ci
 *
 * Entrypoint test for `runTesseraServer`: with no GitHub App configured it
 * serves and answers `app` requests with `provider_unconfigured`; with one
 * configured it registers the github-app provider (driven here against the
 * fake GitHub API) and mints, even after a GitHub outage at startup. Logs name
 * settings only, never their values, and it shuts down cleanly on a signal.
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient } from "./providers/github-app/github-client.js";
import { startFakeGitHub, type FakeGitHub } from "./testing/fake-github.js";
import { TesseraValidationError } from "./types.js";
import { runTesseraServer } from "./serve.js";

const CLIENT_KEY = "tessera-serve-test-client-key";

/** A client-keys file registering one client by its key's SHA-256. */
function writeClientKeysFile(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-clients-"));
  const file = path.join(dir, "clients.json");
  const keySha256 = createHash("sha256").update(CLIENT_KEY, "utf8").digest("hex");
  fs.writeFileSync(file, JSON.stringify([{ client: "herald", key_sha256: keySha256 }]));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

function captureLogger(): { logger: pino.Logger; lines: () => string[] } {
  const stream = new PassThrough();
  const chunks: string[] = [];
  stream.on("data", (chunk: Buffer) => chunks.push(chunk.toString("utf-8")));
  return {
    logger: pino({ level: "info" }, stream),
    lines: () => chunks.join("").split("\n").filter(Boolean),
  };
}

async function waitForHealthz(url: string): Promise<Response> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await fetch(url);
    } catch {
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new Error(`server never answered ${url}`);
}

async function postToken(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/github/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
    body: JSON.stringify(body),
  });
}

describe("runTesseraServer", () => {
  let clientKeys: { file: string; cleanup: () => void } | undefined;

  afterEach(() => {
    clientKeys?.cleanup();
    clientKeys = undefined;
  });

  function clientKeysFile(): string {
    clientKeys ??= writeClientKeysFile();
    return clientKeys.file;
  }

  it("serves unconfigured, logs setting names only, and stops on SIGTERM", async () => {
    const port = await freePort();
    const signals = new EventEmitter();
    const { logger, lines } = captureLogger();

    const running = runTesseraServer({
      port,
      host: "127.0.0.1",
      env: {
        TESSERA_GITHUB_APP_ID: "app-id-sentinel-do-not-log",
        TESSERA_GITHUB_APP_KEY_FILE: "/no/such/key.pem",
        TESSERA_CLIENT_KEYS_FILE: clientKeysFile(),
      },
      logger,
      signals,
    });

    const res = await waitForHealthz(`http://127.0.0.1:${port}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok" });

    const token = await postToken(port, { identity: "app", repo: "acme/widgets", access: "read" });
    expect(token.status).toBe(503);
    expect(((await token.json()) as { error: { code: string } }).error.code).toBe("provider_unconfigured");

    signals.emit("SIGTERM");
    await expect(running).resolves.toBeUndefined();

    const output = lines().join("\n");
    expect(output).toContain("TESSERA_GITHUB_APP_KEY_FILE");
    expect(output).not.toContain("app-id-sentinel-do-not-log");
    expect(output).not.toContain("/no/such/key.pem");
    expect(output).toContain("received SIGTERM");

    // The port is released after shutdown.
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });

  it("rejects an invalid port before the server starts", async () => {
    await expect(
      runTesseraServer({ port: "9689x", env: {} }),
    ).rejects.toBeInstanceOf(TesseraValidationError);
  });

  describe("with a configured GitHub App", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let fake: FakeGitHub | undefined;
    let keyDir: string | undefined;

    afterEach(async () => {
      await fake?.close();
      fake = undefined;
      if (keyDir) fs.rmSync(keyDir, { recursive: true, force: true });
      keyDir = undefined;
    });

    async function start(failAppAtStartup: boolean) {
      fake = await startFakeGitHub({
        app: { id: 42, slug: "march-bot" },
        botUserId: 123456,
        installations: { acme: { id: 7 } },
        publicKey,
      });
      if (failAppAtStartup) fake.fail("app", { status: 503 });
      keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-serve-"));
      const keyFile = path.join(keyDir, "app-key-sentinel.pem");
      fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
        mode: 0o600,
      });
      const port = await freePort();
      const signals = new EventEmitter();
      const { logger, lines } = captureLogger();
      const running = runTesseraServer({
        port,
        host: "127.0.0.1",
        env: {
          TESSERA_GITHUB_APP_ID: "42",
          TESSERA_GITHUB_APP_KEY_FILE: keyFile,
          TESSERA_CLIENT_KEYS_FILE: clientKeysFile(),
        },
        logger,
        signals,
        githubClient: new GitHubClient({ baseUrl: fake.baseUrl }),
      });
      await waitForHealthz(`http://127.0.0.1:${port}/healthz`);
      return { fake, port, signals, running, lines, keyFile };
    }

    it("registers the provider, mints over HTTP, and logs setting names only", async () => {
      const h = await start(false);
      const res = await postToken(h.port, { identity: "app", repo: "acme/widgets", access: "write" });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { token: string; identity: string };
      expect(body.identity).toBe("march-bot[bot]");
      expect(body.token).toMatch(/^ghs_fake/);

      const status = (await (await fetch(`http://127.0.0.1:${h.port}/status`)).json()) as {
        providers: Array<{ state: string; login: string | null }>;
      };
      expect(status.providers).toMatchObject([{ state: "ok", login: "march-bot[bot]" }]);

      h.signals.emit("SIGTERM");
      await expect(h.running).resolves.toBeUndefined();

      const output = h.lines().join("\n");
      expect(output).toContain("GitHub App provider configured (TESSERA_GITHUB_APP_ID, TESSERA_GITHUB_APP_KEY_FILE)");
      expect(output).toContain("github-app provider state: ok");
      expect(output).not.toContain(h.keyFile);
      expect(output).not.toContain("app-key-sentinel");
      expect(output).not.toContain(body.token);
      expect(output).not.toContain("BEGIN PRIVATE KEY");
    });

    it("still serves when GitHub is down at startup, and mints once it recovers", async () => {
      const h = await start(true);
      const status = (await (await fetch(`http://127.0.0.1:${h.port}/status`)).json()) as {
        providers: Array<{ state: string }>;
      };
      expect(status.providers).toMatchObject([{ state: "degraded" }]);
      const refused = await postToken(h.port, { identity: "app", repo: "acme/widgets", access: "read" });
      expect(refused.status).toBe(503);
      expect(refused.headers.get("retry-after")).not.toBeNull();

      h.fake.fail("app", null);
      const ok = await postToken(h.port, { identity: "app", repo: "acme/widgets", access: "read" });
      expect(ok.status).toBe(200);

      h.signals.emit("SIGTERM");
      await expect(h.running).resolves.toBeUndefined();
      expect(h.lines().join("\n")).toContain("github-app provider state: degraded (last_error: provider_unavailable)");
    });
  });
});
