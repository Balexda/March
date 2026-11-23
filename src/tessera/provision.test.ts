/** @l0 @deterministic @ci */
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadTesseraAuthorization } from "./authorization.js";
import { normalizeRepos, provisionTessera, TESSERA_CLIENT_GRANTS, TesseraProvisionError } from "./provision.js";
import { readClientKeyFileSync, resolveTesseraConfig } from "./config.js";
import { buildTesseraServer } from "./server.js";
import { TesseraClient } from "./client.js";

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "tessera-provision-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

const mode = (p: string) => statSync(p).mode & 0o777;
let n = 0;
const keys = () => `key-${++n}-${"x".repeat(20)}`;

describe("provisionTessera", () => {
  it("writes digests, policy, 0600 keys and the steward key; Tessera loads the result", async () => {
    const result = provisionTessera({ repos: ["Acme/Widgets", "acme/tools", "acme/widgets"], githubToken: "gho_abc\n", home, generateKey: keys });
    const dir = join(home, ".march", "tessera");
    expect(result.dir).toBe(dir);
    expect(result.repos).toEqual(["acme/tools", "acme/widgets"]);
    expect(mode(dir)).toBe(0o700);
    expect(result.clients.map((c) => c.client)).toEqual(TESSERA_CLIENT_GRANTS.map((g) => g.client));
    for (const c of result.clients) {
      expect(c.created).toBe(true);
      expect(mode(c.keyPath)).toBe(0o600);
    }
    const clients = JSON.parse(readFileSync(join(dir, "clients.json"), "utf8"));
    const hatcheryKey = readFileSync(join(dir, "keys", "hatchery.key"), "utf8");
    expect(clients).toContainEqual({ client: "hatchery", key_sha256: createHash("sha256").update(hatcheryKey).digest("hex") });
    expect(JSON.stringify(clients)).not.toContain(hatcheryKey);
    const policy = JSON.parse(readFileSync(join(dir, "policy.json"), "utf8"));
    expect(policy).toContainEqual({ client: "legate", identities: ["app", "user"], repos: ["acme/tools", "acme/widgets"], max_access: "write" });
    expect(policy).toContainEqual({ client: "hatchery", identities: ["app"], repos: ["acme/tools", "acme/widgets"], max_access: "read" });
    expect(readFileSync(join(dir, "github-token"), "utf8")).toBe("gho_abc\n");
    expect(mode(join(dir, "github-token"))).toBe(0o600);
    expect(readFileSync(result.stewardKeyPath, "utf8")).toBe(readFileSync(join(dir, "keys", "steward.key"), "utf8"));
    expect(mode(result.stewardKeyPath)).toBe(0o600);

    // The written files are a valid Tessera configuration and grant what they say.
    const auth = await loadTesseraAuthorization({ TESSERA_CLIENT_KEYS_FILE: join(dir, "clients.json"), TESSERA_POLICY_FILE: join(dir, "policy.json") });
    const caller = await auth.authenticate(`Bearer ${hatcheryKey}`);
    expect(caller).toBe("hatchery");
    expect(() => auth.authorize(caller, { identity: "app", repo: "acme/widgets", access: "read" })).not.toThrow();
    expect(() => auth.authorize(caller, { identity: "app", repo: "acme/widgets", access: "write" })).toThrow();
    const legate = await auth.authenticate(`Bearer ${readFileSync(join(dir, "keys", "legate.key"), "utf8")}`);
    expect(() => auth.authorize(legate, { identity: "user", access: "write" })).not.toThrow();

    // A consumer reads its key through MARCH_TESSERA_CLIENT_KEY_FILE.
    expect(readClientKeyFileSync(join(dir, "keys", "hatchery.key"))).toBe(hatcheryKey);
    expect(resolveTesseraConfig({ env: { MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_CLIENT_KEY_FILE: join(dir, "keys", "hatchery.key") } }))
      .toEqual({ baseUrl: "http://tessera:9477", clientKey: hatcheryKey });
  });

  it("GET /v1/client returns only the caller's own grants, and 401s a bad key", async () => {
    provisionTessera({ repos: ["acme/widgets"], githubToken: "gho_abc", home, generateKey: keys });
    const dir = join(home, ".march", "tessera");
    const authorize = await loadTesseraAuthorization({ TESSERA_CLIENT_KEYS_FILE: join(dir, "clients.json"), TESSERA_POLICY_FILE: join(dir, "policy.json") });
    const app = buildTesseraServer({ authorize, logger: false });
    try {
      const hatcheryKey = readFileSync(join(dir, "keys", "hatchery.key"), "utf8");
      const ok = await app.inject({ method: "GET", url: "/v1/client", headers: { authorization: `Bearer ${hatcheryKey}` } });
      expect(ok.statusCode).toBe(200);
      expect(ok.json()).toEqual({ client: "hatchery", grants: [{ identity: "app", access: "read", repos: ["acme/widgets"] }] });
      expect(ok.body).not.toContain(hatcheryKey);
      expect(ok.body).not.toContain("legate");
      const legateKey = readFileSync(join(dir, "keys", "legate.key"), "utf8");
      const legate = await app.inject({ method: "GET", url: "/v1/client", headers: { authorization: `Bearer ${legateKey}` } });
      expect(legate.json().grants).toEqual([
        { identity: "app", access: "write", repos: ["acme/widgets"] },
        { identity: "user", access: "write", repos: [] },
      ]);
      const bad = await app.inject({ method: "GET", url: "/v1/client", headers: { authorization: "Bearer not-a-key" } });
      expect(bad.statusCode).toBe(401);
      expect(bad.json()).toEqual({ error: { code: "unauthorized", message: "Client authentication required" } });
      expect((await app.inject({ method: "GET", url: "/v1/client" })).statusCode).toBe(401);

      // The Node client speaks it end to end.
      const fetchImpl = (async (url: string, init?: RequestInit) => {
        const res = await app.inject({ method: "GET", url: new URL(url).pathname, headers: init?.headers as Record<string, string> });
        return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;
      expect(await new TesseraClient({ baseUrl: "http://tessera", clientKey: hatcheryKey, env: {}, fetchImpl }).client())
        .toEqual({ client: "hatchery", grants: [{ identity: "app", access: "read", repos: ["acme/widgets"] }] });
      await expect(new TesseraClient({ baseUrl: "http://tessera", clientKey: "nope", env: {}, fetchImpl }).client())
        .rejects.toMatchObject({ code: "unauthorized", status: 401 });
    } finally {
      await app.close();
    }
  });

  it("keeps existing keys and the token on rerun, and updates the repos", () => {
    provisionTessera({ repos: ["acme/widgets"], githubToken: "gho_abc", home, generateKey: keys });
    const before = readFileSync(join(home, ".march", "tessera", "keys", "legate.key"), "utf8");
    const again = provisionTessera({ repos: ["acme/*"], home, generateKey: keys });
    expect(again.clients.every((c) => !c.created)).toBe(true);
    expect(again.githubToken).toBe("kept");
    expect(readFileSync(join(home, ".march", "tessera", "keys", "legate.key"), "utf8")).toBe(before);
    expect(JSON.parse(readFileSync(join(home, ".march", "tessera", "policy.json"), "utf8"))[0].repos).toEqual(["acme/*"]);
  });

  it("reports a missing token and refuses an empty or invalid repo list", () => {
    expect(provisionTessera({ repos: ["acme/widgets"], home, generateKey: keys }).githubToken).toBe("missing");
    expect(() => provisionTessera({ repos: [], home })).toThrow(TesseraProvisionError);
    expect(() => normalizeRepos(["not a repo"])).toThrow(TesseraProvisionError);
  });
});

describe("readClientKeyFileSync", () => {
  it("fails closed on a missing or loosely-permissioned file", () => {
    expect(readClientKeyFileSync(join(home, "absent.key"))).toBeUndefined();
    provisionTessera({ repos: ["acme/widgets"], home, generateKey: keys });
    const file = join(home, ".march", "tessera", "keys", "herald.key");
    chmodSync(file, 0o644);
    expect(readClientKeyFileSync(file)).toBeUndefined();
    // With the key file named but unusable, the env key is NOT used.
    expect(resolveTesseraConfig({ env: { MARCH_TESSERA_URL: "http://tessera:9477", MARCH_TESSERA_CLIENT_KEY_FILE: file, MARCH_TESSERA_CLIENT_KEY: "env-key" } }))
      .toBeUndefined();
  });
});
