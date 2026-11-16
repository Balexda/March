/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  TESSERA_CONSUMER_ENV,
  TESSERA_GITHUB_APP_ID_ENV,
  TESSERA_GITHUB_APP_KEY_FILE_ENV,
  TESSERA_GITHUB_INSTALLATION_ID_ENV,
  TESSERA_PORT_ENV,
  TESSERA_SERVICE_NAME,
  resolveGitHubAppConfig,
  resolveTesseraPort,
  tesseraPort,
} from "./config.js";
import {
  ACCESS_PROFILES,
  CredentialInvalidError,
  MintFailedError,
  ProviderUnavailableError,
  ProviderUnconfiguredError,
  RepoNotInstalledError,
  TesseraError,
  TesseraValidationError,
} from "./types.js";

const env = (vars: Record<string, string> = {}) => vars as NodeJS.ProcessEnv;
const exists = () => true;
const missing = () => false;

describe("tessera port", () => {
  it("derives the default port from march-tessera", () => {
    expect(TESSERA_SERVICE_NAME).toBe("march-tessera");
    expect(tesseraPort()).toBe(9477);
    expect(resolveTesseraPort(undefined, env())).toBe(9477);
  });

  it("accepts explicit and MARCH_TESSERA_PORT overrides", () => {
    expect(TESSERA_PORT_ENV).toBe("MARCH_TESSERA_PORT");
    expect(resolveTesseraPort(9123, env())).toBe(9123);
    expect(resolveTesseraPort("9200", env())).toBe(9200);
    expect(resolveTesseraPort(undefined, env({ MARCH_TESSERA_PORT: "9124" }))).toBe(9124);
  });

  it("rejects invalid ports with a typed validation error", () => {
    for (const bad of ["9477x", "70000", "0", "-1", "abc"]) {
      expect(() => resolveTesseraPort(undefined, env({ MARCH_TESSERA_PORT: bad }))).toThrow(
        TesseraValidationError,
      );
    }
    expect(() => resolveTesseraPort(0, env())).toThrow(TesseraValidationError);
    expect(() => resolveTesseraPort(1.5, env())).toThrow(TesseraValidationError);
  });
});

describe("github app config", () => {
  it("is unconfigured, not a throw, when the app id or key file is missing", () => {
    expect(resolveGitHubAppConfig(env(), exists)).toEqual({
      configured: false,
      missing: [TESSERA_GITHUB_APP_ID_ENV, TESSERA_GITHUB_APP_KEY_FILE_ENV],
    });
    expect(
      resolveGitHubAppConfig(env({ TESSERA_GITHUB_APP_KEY_FILE: "/secrets/app.pem" }), exists),
    ).toEqual({ configured: false, missing: [TESSERA_GITHUB_APP_ID_ENV] });
    expect(resolveGitHubAppConfig(env({ TESSERA_GITHUB_APP_ID: "  " }), exists)).toEqual({
      configured: false,
      missing: [TESSERA_GITHUB_APP_ID_ENV, TESSERA_GITHUB_APP_KEY_FILE_ENV],
    });
  });

  it("is unconfigured when the key file does not exist on disk", () => {
    expect(
      resolveGitHubAppConfig(
        env({ TESSERA_GITHUB_APP_ID: "123", TESSERA_GITHUB_APP_KEY_FILE: "/nope.pem" }),
        missing,
      ),
    ).toEqual({ configured: false, missing: [TESSERA_GITHUB_APP_KEY_FILE_ENV] });
  });

  it("resolves a configured app with an optional installation id", () => {
    const base = { TESSERA_GITHUB_APP_ID: "123", TESSERA_GITHUB_APP_KEY_FILE: "/secrets/app.pem" };
    expect(resolveGitHubAppConfig(env(base), exists)).toEqual({
      configured: true,
      appId: "123",
      keyFile: "/secrets/app.pem",
      installationId: undefined,
    });
    expect(
      resolveGitHubAppConfig(env({ ...base, TESSERA_GITHUB_INSTALLATION_ID: "42" }), exists),
    ).toEqual({
      configured: true,
      appId: "123",
      keyFile: "/secrets/app.pem",
      installationId: 42,
    });
  });

  it("rejects an invalid installation id with a typed validation error", () => {
    expect(() =>
      resolveGitHubAppConfig(
        env({
          TESSERA_GITHUB_APP_ID: "123",
          TESSERA_GITHUB_APP_KEY_FILE: "/k.pem",
          TESSERA_GITHUB_INSTALLATION_ID: "4x",
        }),
        exists,
      ),
    ).toThrow(TesseraValidationError);
  });

  it("reads server-side settings only under TESSERA_* and no client-key/policy settings", () => {
    const serverNames = [
      TESSERA_GITHUB_APP_ID_ENV,
      TESSERA_GITHUB_APP_KEY_FILE_ENV,
      TESSERA_GITHUB_INSTALLATION_ID_ENV,
    ];
    for (const name of serverNames) expect(name).toMatch(/^TESSERA_/);
    for (const name of Object.values(TESSERA_CONSUMER_ENV)) expect(name).toMatch(/^MARCH_TESSERA_/);

    const read = new Set<string>();
    const spyEnv = new Proxy({} as NodeJS.ProcessEnv, {
      get(_t, key) {
        if (typeof key === "string") read.add(key);
        return undefined;
      },
    });
    resolveGitHubAppConfig(spyEnv, exists);
    expect([...read].sort()).toEqual([...serverNames].sort());
    expect(read.has("TESSERA_POLICY_FILE")).toBe(false);
    expect(read.has("TESSERA_CLIENT_KEYS_FILE")).toBe(false);
  });
});

describe("access profiles", () => {
  it("makes write a strict superset of read and excludes workflows", () => {
    const read = ACCESS_PROFILES.read;
    const write = ACCESS_PROFILES.write;
    expect(read).toEqual({
      metadata: "read",
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      statuses: "read",
    });
    for (const key of Object.keys(read)) expect(write).toHaveProperty(key);
    expect(write).toMatchObject({ contents: "write", pull_requests: "write", issues: "write" });
    for (const profile of [read, write]) {
      expect(profile).not.toHaveProperty("workflows");
      expect(profile).not.toHaveProperty("administration");
      expect(profile).not.toHaveProperty("members");
    }
    expect(Object.isFrozen(ACCESS_PROFILES)).toBe(true);
    expect(Object.isFrozen(read)).toBe(true);
    expect(Object.isFrozen(write)).toBe(true);
  });
});

describe("typed errors", () => {
  it("carries a code and HTTP status per US1 error condition", () => {
    const cases: Array<[TesseraError, string, number]> = [
      [new TesseraValidationError("bad"), "invalid_request", 400],
      [new RepoNotInstalledError("x"), "repo_not_installed", 422],
      [new ProviderUnconfiguredError("x"), "provider_unconfigured", 503],
      [new CredentialInvalidError("x"), "credential_invalid", 503],
      [new ProviderUnavailableError("x"), "provider_unavailable", 503],
      [new MintFailedError("x"), "mint_failed", 502],
    ];
    for (const [err, code, status] of cases) {
      expect(err).toBeInstanceOf(TesseraError);
      expect(err).toBeInstanceOf(Error);
      expect(err.code).toBe(code);
      expect(err.status).toBe(status);
    }
  });

  it("gives provider_unavailable a Retry-After value", () => {
    expect(new ProviderUnavailableError("down").retryAfterSeconds).toBeGreaterThan(0);
    expect(new ProviderUnavailableError("down", 7).retryAfterSeconds).toBe(7);
  });
});
