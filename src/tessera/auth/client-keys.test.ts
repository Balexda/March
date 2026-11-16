/**
 * @l0 @deterministic @ci
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TESSERA_CLIENT_KEYS_FILE_ENV, resolveClientKeysFile } from "../config.js";
import { TesseraValidationError, UnauthorizedError } from "../types.js";
import {
  loadClientRegistry,
  loadClientRegistryFromFile,
  parseClientRegistry,
  type ClientKeysFileReader,
} from "./client-keys.js";

const sha = (key: string): string => createHash("sha256").update(key, "utf8").digest("hex");

const HERALD_KEY = "herald-plaintext-key-0001";
const LEGATE_KEY = "legate-plaintext-key-0002";

const validEntries = [
  { client: "herald", key_sha256: sha(HERALD_KEY) },
  { client: "legate", key_sha256: sha(LEGATE_KEY) },
];

const readerFor =
  (contents: string): ClientKeysFileReader =>
  () =>
    contents;

function expectLoadError(contents: string, ...fragments: string[]): TesseraValidationError {
  let caught: unknown;
  try {
    parseClientRegistry(contents);
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(TesseraValidationError);
  const message = (caught as Error).message;
  expect(message).toContain(TESSERA_CLIENT_KEYS_FILE_ENV);
  for (const fragment of fragments) expect(message).toContain(fragment);
  // Never the file contents or any hash.
  for (const e of validEntries) expect(message).not.toContain(e.key_sha256);
  if (contents.trim().length > 8) expect(message).not.toContain(contents.trim());
  return caught as TesseraValidationError;
}

describe("resolveClientKeysFile", () => {
  it("returns the trimmed path", () => {
    expect(resolveClientKeysFile({ [TESSERA_CLIENT_KEYS_FILE_ENV]: " /etc/tessera/keys.json " })).toBe(
      "/etc/tessera/keys.json",
    );
  });

  it.each([undefined, "", "   "])("rejects an unset or blank setting (%j)", (value) => {
    const env = value === undefined ? {} : { [TESSERA_CLIENT_KEYS_FILE_ENV]: value };
    expect(() => resolveClientKeysFile(env)).toThrow(TesseraValidationError);
    expect(() => resolveClientKeysFile(env)).toThrow(TESSERA_CLIENT_KEYS_FILE_ENV);
  });
});

describe("loadClientRegistry", () => {
  it("loads the file named by the setting", () => {
    const seen: string[] = [];
    const registry = loadClientRegistry({ [TESSERA_CLIENT_KEYS_FILE_ENV]: "/keys.json" }, (path) => {
      seen.push(path);
      return Buffer.from(JSON.stringify(validEntries), "utf8");
    });
    expect(seen).toEqual(["/keys.json"]);
    expect(registry.size).toBe(2);
    expect(registry.clients()).toEqual(["herald", "legate"]);
  });

  it("rejects an unset setting instead of allowing all", () => {
    expect(() => loadClientRegistry({}, readerFor(JSON.stringify(validEntries)))).toThrow(TesseraValidationError);
  });

  it("rejects a missing or unreadable file without naming the path or the underlying error", () => {
    const reader: ClientKeysFileReader = () => {
      throw new Error("ENOENT: /secret/path/keys.json");
    };
    let caught: unknown;
    try {
      loadClientRegistryFromFile("/secret/path/keys.json", reader);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(TesseraValidationError);
    const message = (caught as Error).message;
    expect(message).toContain(TESSERA_CLIENT_KEYS_FILE_ENV);
    expect(message).not.toContain("/secret/path");
    expect(message).not.toContain("ENOENT");
  });

  it("reads the real filesystem by default", () => {
    expect(() => loadClientRegistryFromFile("/nonexistent/tessera/client-keys.json")).toThrow(
      TesseraValidationError,
    );
  });
});

describe("parseClientRegistry validation", () => {
  it.each(["", "   \n\t "])("rejects a blank file (%j)", (contents) => {
    expectLoadError(contents, "empty");
  });

  it("rejects non-JSON without echoing the contents", () => {
    expectLoadError("{not json at all, secret-ish", "JSON");
  });

  it.each([
    JSON.stringify({ client: "herald", key_sha256: sha(HERALD_KEY) }),
    "null",
    '"a string"',
    "42",
  ])("rejects a non-array top level (%s)", (contents) => {
    expectLoadError(contents, "array");
  });

  it("rejects an empty list", () => {
    expectLoadError("[]", "at least one");
  });

  it("rejects an entry that is not an object", () => {
    expectLoadError(JSON.stringify([validEntries[0], "herald"]), "entry 2");
    expectLoadError(JSON.stringify([null]), "entry 1");
    expectLoadError(JSON.stringify([[]]), "entry 1");
  });

  it("rejects an unknown field without naming it", () => {
    const err = expectLoadError(
      JSON.stringify([validEntries[0], { ...validEntries[1], key: "plaintext-oops" }]),
      "entry 2",
      "unknown field",
    );
    expect(err.message).not.toContain("plaintext-oops");
  });

  it("rejects a missing field", () => {
    expectLoadError(JSON.stringify([{ client: "herald" }]), "entry 1", "key_sha256");
    expectLoadError(JSON.stringify([{ key_sha256: sha(HERALD_KEY) }]), "entry 1", "client");
  });

  it.each(["Herald", "1herald", "-herald", "", "her ald", "a".repeat(33), "herald_x", 7])(
    "rejects a bad client name (%j)",
    (client) => {
      const err = expectLoadError(
        JSON.stringify([validEntries[0], { client, key_sha256: sha(LEGATE_KEY) }]),
        "entry 2",
        "client",
      );
      if (typeof client === "string" && client.length > 0) expect(err.message).not.toContain(client);
    },
  );

  it("accepts the longest and shortest valid client names", () => {
    const registry = parseClientRegistry(
      JSON.stringify([
        { client: "a", key_sha256: sha("k1") },
        { client: `a${"b-9".repeat(10)}c`, key_sha256: sha("k2") },
      ]),
    );
    expect(registry.size).toBe(2);
  });

  it.each([
    ["uppercase", sha(HERALD_KEY).toUpperCase()],
    ["too short", sha(HERALD_KEY).slice(0, 63)],
    ["too long", `${sha(HERALD_KEY)}0`],
    ["non-hex", `${sha(HERALD_KEY).slice(0, 63)}g`],
    ["not a string", 1234],
  ])("rejects a malformed hash (%s)", (_label, key_sha256) => {
    const err = expectLoadError(
      JSON.stringify([validEntries[0], { client: "legate", key_sha256 }]),
      "entry 2",
      "key_sha256",
    );
    if (typeof key_sha256 === "string") expect(err.message).not.toContain(key_sha256);
  });

  it("rejects a duplicate client", () => {
    const err = expectLoadError(
      JSON.stringify([validEntries[0], validEntries[1], { client: "herald", key_sha256: sha("other") }]),
      "entry 3",
      "duplicate",
    );
    expect(err.message).toContain("entry 1");
  });

  it("rejects a duplicate hash", () => {
    const err = expectLoadError(
      JSON.stringify([validEntries[0], { client: "legate", key_sha256: sha(HERALD_KEY) }]),
      "entry 2",
      "duplicate",
    );
    expect(err.message).toContain("entry 1");
  });
});

describe("ClientRegistry", () => {
  const registry = parseClientRegistry(JSON.stringify(validEntries));

  it("resolves a registered key to its client name", () => {
    expect(registry.authenticate(HERALD_KEY)).toBe("herald");
    expect(registry.authenticate(LEGATE_KEY)).toBe("legate");
  });

  it.each([
    ["empty", ""],
    ["unknown", "not-a-registered-key"],
    ["the hash itself", sha(HERALD_KEY)],
    ["near miss", `${HERALD_KEY} `],
    ["very long", "x".repeat(1_000_000)],
    ["non-ascii", "ключ\u0000🔑"],
  ])("resolves an %s key to no client without throwing", (_label, key) => {
    expect(registry.authenticate(key)).toBeUndefined();
  });

  it("does not throw for a non-string presented key", () => {
    expect(registry.authenticate(undefined as unknown as string)).toBeUndefined();
    expect(registry.authenticate(42 as unknown as string)).toBeUndefined();
  });

  it("is immutable", () => {
    const names = registry.clients() as string[];
    expect(Object.isFrozen(names)).toBe(true);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(() => names.push("intruder")).toThrow();
    expect(registry.size).toBe(2);
  });

  it("never retains a plaintext key or exposes a hash", () => {
    registry.authenticate(HERALD_KEY);
    const serialized = JSON.stringify(registry) + String(registry) + JSON.stringify(Object.entries(registry));
    expect(serialized).not.toContain(HERALD_KEY);
    for (const e of validEntries) expect(serialized).not.toContain(e.key_sha256);
  });
});

describe("UnauthorizedError", () => {
  it("is a 401 unauthorized with one fixed message", () => {
    const a = new UnauthorizedError();
    const b = new UnauthorizedError();
    expect(a.code).toBe("unauthorized");
    expect(a.status).toBe(401);
    expect(a.message).toBe(b.message);
    expect(a.message.length).toBeGreaterThan(0);
    expect(a.name).toBe("UnauthorizedError");
  });
});
