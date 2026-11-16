/**
 * @l0 @deterministic @ci
 */
import { generateKeyPairSync, verify } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { TESSERA_GITHUB_APP_KEY_FILE_ENV } from "../../config.js";
import { CredentialInvalidError } from "../../types.js";
import {
  APP_ASSERTION_BACKDATE_SECONDS,
  APP_ASSERTION_LIFETIME_SECONDS,
  createAppAssertionSigner,
  loadAppPrivateKey,
  signAppAssertion,
} from "./app-assertion.js";

// Throwaway key pair generated at runtime; no key is ever committed.
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privatePem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const pkcs8Pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

const dir = mkdtempSync(join(tmpdir(), "tessera-assertion-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function writeKey(name: string, contents: string): string {
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function decodeSegment(segment: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

function parts(jwt: string): [string, string, string] {
  const split = jwt.split(".");
  expect(split).toHaveLength(3);
  return split as [string, string, string];
}

const NOW_MS = Date.parse("2026-11-15T12:00:00.000Z");
const NOW_S = NOW_MS / 1000;

describe("signAppAssertion", () => {
  it("produces an RS256 JWT that verifies against the matching public key", () => {
    const jwt = signAppAssertion({ appId: "12345", privateKey, now: () => NOW_MS });
    const [header, payload, signature] = parts(jwt);

    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const ok = verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
    expect(ok).toBe(true);
  });

  it("fails verification against an unrelated public key", () => {
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey;
    const [header, payload, signature] = parts(
      signAppAssertion({ appId: "12345", privateKey, now: () => NOW_MS }),
    );
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), other, Buffer.from(signature, "base64url")),
    ).toBe(false);
  });

  it("sets iss to the app id, backdates iat and stays under the ten-minute cap", () => {
    const [, payload] = parts(signAppAssertion({ appId: "12345", privateKey, now: () => NOW_MS }));
    const claims = decodeSegment(payload);

    expect(claims.iss).toBe("12345");
    expect(claims.iat).toBe(NOW_S - APP_ASSERTION_BACKDATE_SECONDS);
    expect(APP_ASSERTION_BACKDATE_SECONDS).toBeGreaterThanOrEqual(30);
    expect(claims.exp).toBe(NOW_S + APP_ASSERTION_LIFETIME_SECONDS);
    expect((claims.exp as number) - NOW_S).toBeLessThan(600);
    expect((claims.exp as number) - (claims.iat as number)).toBeLessThanOrEqual(600);
    expect(claims.exp as number).toBeGreaterThan(NOW_S);
  });

  it("uses integer seconds even when the clock has sub-second precision", () => {
    const [, payload] = parts(signAppAssertion({ appId: "1", privateKey, now: () => NOW_MS + 999 }));
    const claims = decodeSegment(payload);
    expect(Number.isInteger(claims.iat)).toBe(true);
    expect(Number.isInteger(claims.exp)).toBe(true);
    expect(claims.iat).toBe(NOW_S - APP_ASSERTION_BACKDATE_SECONDS);
  });
});

describe("loadAppPrivateKey", () => {
  it("loads PKCS#1 and PKCS#8 PEM RSA keys", () => {
    for (const [name, pem] of [
      ["pkcs1.pem", privatePem],
      ["pkcs8.pem", pkcs8Pem],
    ] as const) {
      const key = loadAppPrivateKey(writeKey(name, pem));
      expect(key.type).toBe("private");
      expect(key.asymmetricKeyType).toBe("rsa");
    }
  });

  function expectCredentialInvalid(fn: () => unknown, forbidden: readonly string[]): CredentialInvalidError {
    let caught: unknown;
    try {
      fn();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CredentialInvalidError);
    const err = caught as CredentialInvalidError;
    expect(err.code).toBe("credential_invalid");
    expect(err.message).toContain(TESSERA_GITHUB_APP_KEY_FILE_ENV);
    for (const needle of forbidden) expect(err.message).not.toContain(needle);
    expect(err.message).not.toMatch(/BEGIN|PRIVATE KEY/);
    expect(err.cause).toBeUndefined();
    return err;
  }

  it("rejects an unreadable key file without naming the path", () => {
    const path = join(dir, "does-not-exist.pem");
    expectCredentialInvalid(() => loadAppPrivateKey(path), [path, dir]);
  });

  it("rejects an unparseable key without echoing its contents", () => {
    const garbage = "-----BEGIN RSA PRIVATE KEY-----\nnot-a-real-key-SECRETBYTES\n-----END RSA PRIVATE KEY-----\n";
    const path = writeKey("garbage.pem", garbage);
    expectCredentialInvalid(() => loadAppPrivateKey(path), [path, "SECRETBYTES", "not-a-real-key"]);
  });

  it("rejects an empty key file", () => {
    const path = writeKey("empty.pem", "");
    expectCredentialInvalid(() => loadAppPrivateKey(path), [path]);
  });

  it("rejects a non-RSA private key, since RS256 needs RSA", () => {
    const ec = generateKeyPairSync("ec", { namedCurve: "P-256" }).privateKey;
    const path = writeKey("ec.pem", ec.export({ type: "pkcs8", format: "pem" }).toString());
    expectCredentialInvalid(() => loadAppPrivateKey(path), [path]);
  });

  it("rejects a public key in place of the private key", () => {
    const path = writeKey("public.pem", publicKey.export({ type: "spki", format: "pem" }).toString());
    expectCredentialInvalid(() => loadAppPrivateKey(path), [path]);
  });

  it("uses fixed messages that are stable across key files", () => {
    const a = writeKey("bad-a.pem", "aaaa");
    const b = writeKey("bad-b.pem", "bbbb");
    const messages = [a, b].map((p) => {
      try {
        loadAppPrivateKey(p);
      } catch (err) {
        return (err as Error).message;
      }
      return "";
    });
    expect(messages[0]).toBe(messages[1]);
  });
});

describe("createAppAssertionSigner", () => {
  it("reads the configured key file and signs with the injected clock", () => {
    let now = NOW_MS;
    const signer = createAppAssertionSigner({
      appId: "777",
      keyFile: writeKey("signer.pem", privatePem),
      now: () => now,
    });

    const first = decodeSegment(parts(signer())[1]);
    now += 120_000;
    const [header, payload, signature] = parts(signer());
    const second = decodeSegment(payload);

    expect(first.iss).toBe("777");
    expect((second.iat as number) - (first.iat as number)).toBe(120);
    expect(
      verify("RSA-SHA256", Buffer.from(`${header}.${payload}`), publicKey, Buffer.from(signature, "base64url")),
    ).toBe(true);
  });

  it("raises credential_invalid at construction for a bad key file", () => {
    const path = writeKey("signer-bad.pem", "nope");
    expect(() => createAppAssertionSigner({ appId: "1", keyFile: path })).toThrow(CredentialInvalidError);
  });
});
