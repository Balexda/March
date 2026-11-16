/**
 * @l1 @deterministic @ci
 *
 * Entrypoint test for `runTesseraServer`: with no GitHub App configured it
 * serves and answers `app` requests with `provider_unconfigured`; with one
 * configured it registers the github-app provider (driven here against the
 * fake GitHub API) and mints, even after a GitHub outage at startup. Logs name
 * settings only, never their values, and it shuts down cleanly on a signal.
 * A missing, empty or invalid client-keys file (TESSERA_CLIENT_KEYS_FILE) or
 * policy file (TESSERA_POLICY_FILE) refuses startup before any GitHub call,
 * with nothing listening; the port is checked first, then the keys, then the
 * policy. Against the running entrypoint with no GitHub App, an allowed
 * request reaches the (absent) provider and an out-of-policy one is 403
 * `policy_denied` (AS 2.2-2.5).
 */
import { createHash, generateKeyPairSync } from "node:crypto";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { GitHubClient } from "./providers/github-app/github-client.js";
import { startFakeGitHub, type FakeGitHub } from "./testing/fake-github.js";
import { POLICY_DENIED_MESSAGES, TesseraValidationError } from "./types.js";
import { runTesseraServer, type RunTesseraServerOptions } from "./serve.js";

const CLIENT_KEY = "tessera-serve-test-client-key";
const CLIENT_KEY_SHA256 = createHash("sha256").update(CLIENT_KEY, "utf8").digest("hex");
const OTHER_SHA256 = createHash("sha256").update("another-client-key", "utf8").digest("hex");

interface ClientFiles {
  readonly file: string;
  readonly policyFile: string;
  readonly cleanup: () => void;
}

/**
 * A client-keys file registering one client by its key's SHA-256, and a
 * policy file granting that client `app` write on `acme/*`.
 */
function writeClientKeysFile(): ClientFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-clients-"));
  const file = path.join(dir, "clients.json");
  const keySha256 = createHash("sha256").update(CLIENT_KEY, "utf8").digest("hex");
  fs.writeFileSync(file, JSON.stringify([{ client: "herald", key_sha256: keySha256 }]));
  const policyFile = path.join(dir, "policy.json");
  fs.writeFileSync(
    policyFile,
    JSON.stringify([{ client: "herald", identities: ["app"], repos: ["acme/*"], max_access: "write" }]),
  );
  return { file, policyFile, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

interface StartedTessera {
  readonly port: number;
  readonly running: Promise<void>;
}

/**
 * Start Tessera on an OS-assigned port (`port: 0`) and resolve once it is
 * listening, with the bound port from `onListening`. Binding port 0 directly
 * avoids the race of probing a free port, releasing it, and rebinding it later
 * (another parallel test can take it in between). A startup failure rejects
 * here with the real error, and `running` never rejects unobserved.
 */
async function startTessera(
  options: Omit<RunTesseraServerOptions, "port" | "onListening">,
): Promise<StartedTessera> {
  let reportListening!: (port: number) => void;
  const listening = new Promise<number>((resolve) => {
    reportListening = resolve;
  });
  const running = runTesseraServer({
    ...options,
    port: 0,
    onListening: ({ port }) => reportListening(port),
  });
  const port = await Promise.race([
    listening,
    running.then(() => {
      throw new Error("runTesseraServer returned before it was listening");
    }),
  ]);
  return { port, running };
}

/**
 * Run a startup that must be refused: resolve with the rejection, and report
 * whether the server ever reached listen (it must not).
 */
async function startRefused(
  options: Omit<RunTesseraServerOptions, "port" | "onListening">,
): Promise<{ err: unknown; listened: boolean }> {
  let listened = false;
  const err = await runTesseraServer({
    ...options,
    port: 0,
    onListening: () => {
      listened = true;
    },
  }).then(
    () => new Error("runTesseraServer resolved; expected a startup refusal"),
    (e: unknown) => e,
  );
  return { err, listened };
}

/**
 * After shutdown, Tessera no longer answers on its port. The released port may
 * already belong to another parallel test, so "something answered" alone is
 * not a failure - only Tessera answering is.
 */
async function expectTesseraGone(port: number): Promise<void> {
  const res = await fetch(`http://127.0.0.1:${port}/status`).catch(() => undefined);
  if (res === undefined) return;
  const body = (await res.json().catch(() => ({}))) as { service?: unknown };
  expect(body.service).not.toBe("march-tessera");
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

async function postToken(port: number, body: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/github/token`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${CLIENT_KEY}` },
    body: JSON.stringify(body),
  });
}

describe("runTesseraServer", () => {
  let clientKeys: ClientFiles | undefined;

  afterEach(() => {
    clientKeys?.cleanup();
    clientKeys = undefined;
  });

  function clientKeysFile(): string {
    clientKeys ??= writeClientKeysFile();
    return clientKeys.file;
  }

  function policyFile(): string {
    clientKeys ??= writeClientKeysFile();
    return clientKeys.policyFile;
  }

  it("serves unconfigured, logs setting names only, and stops on SIGTERM", async () => {
    const signals = new EventEmitter();
    const { logger, lines } = captureLogger();

    const { port, running } = await startTessera({
      host: "127.0.0.1",
      env: {
        TESSERA_GITHUB_APP_ID: "app-id-sentinel-do-not-log",
        TESSERA_GITHUB_APP_KEY_FILE: "/no/such/key.pem",
        TESSERA_CLIENT_KEYS_FILE: clientKeysFile(),
        TESSERA_POLICY_FILE: policyFile(),
      },
      logger,
      signals,
    });

    const res = await fetch(`http://127.0.0.1:${port}/healthz`);
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
    // The client-keys log names the setting and the count, never the path,
    // the hash or the key.
    expect(output).toContain("client keys loaded from TESSERA_CLIENT_KEYS_FILE: 1 registered client");
    expect(output).not.toContain(CLIENT_KEY);
    expect(output).not.toContain(CLIENT_KEY_SHA256);
    expect(output).not.toContain(clientKeysFile());
    expect(output).not.toContain(path.dirname(clientKeysFile()));
    // The policy log names the setting and the rule count, never the path,
    // a client's rule or a repository.
    expect(output).toContain("policy loaded from TESSERA_POLICY_FILE: 1 rule");
    expect(output).not.toContain(policyFile());
    expect(output).not.toContain("acme/*");
    // Only the audit event names a repository: the one submitted (FR-034).
    const nonAudit = lines().filter((line) => !line.includes('"msg":"tessera.audit"'));
    expect(nonAudit.join("\n")).not.toContain("acme");
    expect(output).toContain(`tessera listening on http://127.0.0.1:${port}`);

    // Tessera stops listening after shutdown.
    await expectTesseraGone(port);
  });

  it("rejects port 0 from the CLI string and MARCH_TESSERA_PORT", async () => {
    // Only the numeric options value 0 (tests) means "OS-assigned".
    await expect(runTesseraServer({ port: "0", env: {} })).rejects.toThrow(/Invalid Tessera port "0"/);
    await expect(runTesseraServer({ env: { MARCH_TESSERA_PORT: "0" } })).rejects.toThrow(
      /Invalid Tessera port "0"/,
    );
  });

  it("rejects an invalid port before the server starts", async () => {
    await expect(
      runTesseraServer({ port: "9689x", env: {} }),
    ).rejects.toBeInstanceOf(TesseraValidationError);
  });

  it("reports an invalid port before a client-keys file problem", async () => {
    await expect(
      runTesseraServer({ port: "9689x", env: { TESSERA_CLIENT_KEYS_FILE: "/no/such/clients.json" } }),
    ).rejects.toThrow(/Invalid Tessera port/);
  });

  it("reports a client-keys file problem before a policy file problem", async () => {
    const { err, listened } = await startRefused({
      env: { TESSERA_POLICY_FILE: "/no/such/policy.json" },
    });
    expect(listened).toBe(false);
    expect(err).toBeInstanceOf(TesseraValidationError);
    expect((err as Error).message).toContain("TESSERA_CLIENT_KEYS_FILE");
    expect((err as Error).message).not.toContain("TESSERA_POLICY_FILE");
  });

  it("reports an invalid port before a policy file problem", async () => {
    await expect(
      runTesseraServer({
        port: "9689x",
        env: { TESSERA_CLIENT_KEYS_FILE: clientKeysFile(), TESSERA_POLICY_FILE: "/no/such/policy.json" },
      }),
    ).rejects.toThrow(/Invalid Tessera port/);
  });

  describe("refuses to start without a valid client-keys file", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let dir: string | undefined;

    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function writeFile(contents: string): string {
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "tessera-bad-clients-"));
      const file = path.join(dir, "clients.json");
      fs.writeFileSync(file, contents);
      return file;
    }

    const cases: Array<{ name: string; file: () => string | undefined }> = [
      { name: "the setting is unset", file: () => undefined },
      { name: "the file is missing", file: () => path.join(os.tmpdir(), "tessera-no-such-dir", "clients.json") },
      { name: "the file is empty", file: () => writeFile("") },
      { name: "the file is whitespace", file: () => writeFile("  \n\t ") },
      { name: "the file is not JSON", file: () => writeFile("{not json") },
      {
        name: "an entry is invalid",
        file: () => writeFile(JSON.stringify([{ client: "Herald", key_sha256: CLIENT_KEY_SHA256 }])),
      },
      {
        name: "a client is duplicated",
        file: () =>
          writeFile(
            JSON.stringify([
              { client: "herald", key_sha256: CLIENT_KEY_SHA256 },
              { client: "herald", key_sha256: OTHER_SHA256 },
            ]),
          ),
      },
      {
        name: "a hash is duplicated",
        file: () =>
          writeFile(
            JSON.stringify([
              { client: "herald", key_sha256: CLIENT_KEY_SHA256 },
              { client: "legate", key_sha256: CLIENT_KEY_SHA256 },
            ]),
          ),
      },
    ];

    for (const { name, file } of cases) {
      it(`when ${name}: rejects, names the setting, and nothing listens`, async () => {
        const fake = await startFakeGitHub({
          app: { id: 42, slug: "march-bot" },
          botUserId: 123456,
          installations: { acme: { id: 7 } },
        });
        const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-serve-"));
        try {
          // A configured GitHub App: a bad keys file must fail before any GitHub call.
          const keyFile = path.join(keyDir, "app.pem");
          fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
            mode: 0o600,
          });
          const keysFile = file();
          const env: NodeJS.ProcessEnv = { TESSERA_GITHUB_APP_ID: "42", TESSERA_GITHUB_APP_KEY_FILE: keyFile };
          if (keysFile !== undefined) env.TESSERA_CLIENT_KEYS_FILE = keysFile;
          const { logger, lines } = captureLogger();

          // Nothing listens: with an OS-assigned port there is no fixed port
          // to probe, so assert the server never reached listen instead.
          const { err, listened } = await startRefused({
            host: "127.0.0.1",
            env,
            logger,
            signals: new EventEmitter(),
            githubClient: new GitHubClient({ baseUrl: fake.baseUrl }),
          });
          expect(listened).toBe(false);

          expect(err).toBeInstanceOf(TesseraValidationError);
          const message = (err as Error).message;
          expect(message).toContain("TESSERA_CLIENT_KEYS_FILE");
          if (keysFile !== undefined) expect(message).not.toContain(keysFile);
          expect(message).not.toContain(CLIENT_KEY_SHA256);
          expect(fake.calls).toHaveLength(0);
          expect(lines()).toEqual([]);
        } finally {
          await fake.close();
          fs.rmSync(keyDir, { recursive: true, force: true });
        }
      });
    }
  });

  describe("refuses to start without a valid policy file", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    // Distinctive values that must never appear in a load error.
    const SENTINEL_OWNER = "sentinelowner";
    const SENTINEL_CLIENT = "sentinelclient";
    let dir: string | undefined;

    afterEach(() => {
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    function writeFile(contents: string): string {
      dir ??= fs.mkdtempSync(path.join(os.tmpdir(), "tessera-bad-policy-"));
      const file = path.join(dir, "policy.json");
      fs.writeFileSync(file, contents);
      return file;
    }

    const appRule = { client: "herald", identities: ["app"], repos: [`${SENTINEL_OWNER}/*`], max_access: "read" };
    const cases: Array<{ name: string; file: () => string | undefined }> = [
      { name: "the setting is unset", file: () => undefined },
      { name: "the file is missing", file: () => path.join(os.tmpdir(), "tessera-no-such-dir", "policy.json") },
      { name: "the file is empty", file: () => writeFile("") },
      { name: "the file is not JSON", file: () => writeFile(`[{"client": "${SENTINEL_CLIENT}"`) },
      { name: "the rule list is empty", file: () => writeFile("[]") },
      {
        name: "a rule names an unregistered client",
        file: () => writeFile(JSON.stringify([{ ...appRule, client: SENTINEL_CLIENT }])),
      },
      {
        name: "a non-legate client is granted user",
        file: () => writeFile(JSON.stringify([{ client: "herald", identities: ["user"], max_access: "read" }])),
      },
      {
        name: "a repository entry is a bare *",
        file: () => writeFile(JSON.stringify([{ ...appRule, repos: ["*"] }])),
      },
      {
        name: "an app rule has no repositories",
        file: () => writeFile(JSON.stringify([{ client: "herald", identities: ["app"], max_access: "read" }])),
      },
      {
        name: "a client has a second rule",
        file: () => writeFile(JSON.stringify([appRule, { ...appRule, max_access: "write" }])),
      },
    ];

    for (const { name, file } of cases) {
      it(`when ${name}: rejects, names the setting, and nothing listens`, async () => {
        const fake = await startFakeGitHub({
          app: { id: 42, slug: "march-bot" },
          botUserId: 123456,
          installations: { acme: { id: 7 } },
        });
        const keyDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-serve-"));
        try {
          // A configured GitHub App: a bad policy must fail before any GitHub call.
          const keyFile = path.join(keyDir, "app.pem");
          fs.writeFileSync(keyFile, privateKey.export({ type: "pkcs8", format: "pem" }).toString(), {
            mode: 0o600,
          });
          const policy = file();
          const env: NodeJS.ProcessEnv = {
            TESSERA_GITHUB_APP_ID: "42",
            TESSERA_GITHUB_APP_KEY_FILE: keyFile,
            TESSERA_CLIENT_KEYS_FILE: clientKeysFile(),
          };
          if (policy !== undefined) env.TESSERA_POLICY_FILE = policy;
          const { logger, lines } = captureLogger();

          // Nothing listens: with an OS-assigned port there is no fixed port
          // to probe, so assert the server never reached listen instead.
          const { err, listened } = await startRefused({
            host: "127.0.0.1",
            env,
            logger,
            signals: new EventEmitter(),
            githubClient: new GitHubClient({ baseUrl: fake.baseUrl }),
          });
          expect(listened).toBe(false);

          expect(err).toBeInstanceOf(TesseraValidationError);
          const message = (err as Error).message;
          expect(message).toContain("TESSERA_POLICY_FILE");
          if (policy !== undefined) {
            expect(message).not.toContain(policy);
            expect(message).not.toContain(path.dirname(policy));
          }
          expect(message).not.toContain(SENTINEL_OWNER);
          expect(message).not.toContain(SENTINEL_CLIENT);
          expect(message).not.toContain("herald");
          expect(fake.calls).toHaveLength(0);
          expect(lines()).toEqual([]);
        } finally {
          await fake.close();
          fs.rmSync(keyDir, { recursive: true, force: true });
        }
      });
    }
  });

  describe("enforces the policy with no GitHub App configured", () => {
    // herald: app read on acme/*; legate: app write on acme/widgets plus user;
    // scribe: registered, but has no rule.
    const KEYS = { herald: "serve-herald-key", legate: "serve-legate-key", scribe: "serve-scribe-key" };
    let dir: string | undefined;
    let running: Promise<void> | undefined;
    let signals: EventEmitter | undefined;

    afterEach(async () => {
      signals?.emit("SIGTERM");
      await running;
      running = undefined;
      signals = undefined;
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
      dir = undefined;
    });

    async function start() {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-policy-"));
      const keysFile = path.join(dir, "clients.json");
      fs.writeFileSync(
        keysFile,
        JSON.stringify(
          Object.entries(KEYS).map(([client, key]) => ({
            client,
            key_sha256: createHash("sha256").update(key, "utf8").digest("hex"),
          })),
        ),
      );
      const policy = path.join(dir, "policy.json");
      fs.writeFileSync(
        policy,
        JSON.stringify([
          { client: "herald", identities: ["app"], repos: ["acme/*"], max_access: "read" },
          { client: "legate", identities: ["app", "user"], repos: ["acme/widgets"], max_access: "write" },
        ]),
      );
      signals = new EventEmitter();
      const { logger, lines } = captureLogger();
      const started = await startTessera({
        host: "127.0.0.1",
        env: { TESSERA_CLIENT_KEYS_FILE: keysFile, TESSERA_POLICY_FILE: policy },
        logger,
        signals,
      });
      running = started.running;
      const { port } = started;
      return { port, lines, policy };
    }

    async function request(port: number, client: keyof typeof KEYS, body: unknown) {
      const res = await fetch(`http://127.0.0.1:${port}/v1/github/token`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${KEYS[client]}` },
        body: JSON.stringify(body),
      });
      const json = (await res.json()) as { error: { code: string; message: string } };
      return { status: res.status, code: json.error.code, message: json.error.message };
    }

    it("starts with a rule-less registered client and logs the rule count only", async () => {
      const h = await start();
      const output = h.lines().join("\n");
      expect(output).toContain("client keys loaded from TESSERA_CLIENT_KEYS_FILE: 3 registered clients");
      expect(output).toContain("policy loaded from TESSERA_POLICY_FILE: 2 rules");
      expect(output).not.toContain(h.policy);
      expect(output).not.toContain("acme");
    });

    it("lets an allowed request reach the provider lookup (provider_unconfigured)", async () => {
      const h = await start();
      expect(await request(h.port, "herald", { identity: "app", repo: "ACME/Gadgets", access: "read" })).toMatchObject({
        status: 503,
        code: "provider_unconfigured",
      });
      expect(await request(h.port, "legate", { identity: "user", access: "write" })).toMatchObject({
        status: 503,
        code: "provider_unconfigured",
      });
    });

    const denials: Array<{
      name: string;
      client: keyof typeof KEYS;
      body: Record<string, unknown>;
      dimension: keyof typeof POLICY_DENIED_MESSAGES;
    }> = [
      {
        name: "access above the ceiling",
        client: "herald",
        body: { identity: "app", repo: "acme/widgets", access: "write" },
        dimension: "access",
      },
      {
        name: "a repository outside the allowlist",
        client: "herald",
        body: { identity: "app", repo: "other/widgets", access: "read" },
        dimension: "repository",
      },
      {
        name: "another repository of an exact-entry owner",
        client: "legate",
        body: { identity: "app", repo: "acme/gadgets", access: "read" },
        dimension: "repository",
      },
      {
        name: "user from a non-legate client",
        client: "herald",
        body: { identity: "user", access: "read" },
        dimension: "identity",
      },
      {
        name: "a registered client with no rule",
        client: "scribe",
        body: { identity: "app", repo: "acme/widgets", access: "read" },
        dimension: "identity",
      },
    ];

    for (const { name, client, body, dimension } of denials) {
      it(`denies ${name} with 403 policy_denied`, async () => {
        const h = await start();
        const res = await request(h.port, client, body);
        expect(res).toEqual({ status: 403, code: "policy_denied", message: POLICY_DENIED_MESSAGES[dimension] });
        expect(res.message).not.toContain("acme");
        expect(res.message).not.toContain("other");
      });
    }
  });

  describe("with a configured GitHub App", () => {
    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    let fake: FakeGitHub | undefined;
    let keyDir: string | undefined;
    let stop: (() => Promise<void>) | undefined;

    afterEach(async () => {
      // Stop a server a failed test left running (a no-op after its own SIGTERM).
      await stop?.();
      stop = undefined;
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
      const signals = new EventEmitter();
      const { logger, lines } = captureLogger();
      const { port, running } = await startTessera({
        host: "127.0.0.1",
        env: {
          TESSERA_GITHUB_APP_ID: "42",
          TESSERA_GITHUB_APP_KEY_FILE: keyFile,
          TESSERA_CLIENT_KEYS_FILE: clientKeysFile(),
          TESSERA_POLICY_FILE: policyFile(),
        },
        logger,
        signals,
        githubClient: new GitHubClient({ baseUrl: fake.baseUrl }),
      });
      stop = async () => {
        signals.emit("SIGTERM");
        await running;
      };
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
