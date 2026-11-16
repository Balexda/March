/**
 * Tessera client registrations (data model "Client Registration").
 *
 * The client-keys file named by `TESSERA_CLIENT_KEYS_FILE` is a JSON array of
 * `{ "client": string, "key_sha256": string }` rows. It is loaded once at
 * startup into an immutable {@link ClientRegistry} that resolves a presented
 * bearer key to a client name.
 *
 * Secret handling: the registry holds only the SHA-256 hashes (as bytes); no
 * plaintext key is ever stored. A presented key is hashed and compared in
 * constant time against every stored hash, with no early exit. Load errors are
 * typed {@link TesseraValidationError}s that name the setting and the entry
 * position only — never a path, a hash, a key, a field value or file contents.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import { TESSERA_CLIENT_KEYS_FILE_ENV, resolveClientKeysFile } from "../config.js";
import { TesseraValidationError } from "../types.js";

/** Reads the client-keys file's raw bytes; injectable for tests. */
export type ClientKeysFileReader = (path: string) => Buffer | string;

/** An immutable set of registered clients, keyed by the hash of each client's bearer key. */
export interface ClientRegistry {
  /** Number of registered clients. */
  readonly size: number;
  /**
   * Resolve a presented bearer key to its client name, or `undefined` when it
   * matches no registration. Never throws, whatever the input.
   */
  authenticate(presentedKey: string): string | undefined;
  /** Registered client names, in file order. Names only; never hashes. */
  clients(): readonly string[];
}

const CLIENT_NAME_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const KEY_SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ALLOWED_FIELDS: ReadonlySet<string> = new Set(["client", "key_sha256"]);

function invalid(problem: string): TesseraValidationError {
  return new TesseraValidationError(`Invalid ${TESSERA_CLIENT_KEYS_FILE_ENV}: ${problem}.`);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value, "utf8").digest();
}

class HashedClientRegistry implements ClientRegistry {
  readonly size: number;
  readonly #names: readonly string[];
  readonly #hashes: readonly Buffer[];

  constructor(names: readonly string[], hashes: readonly Buffer[]) {
    this.#names = Object.freeze([...names]);
    this.#hashes = Object.freeze([...hashes]);
    this.size = this.#names.length;
    Object.freeze(this);
  }

  authenticate(presentedKey: string): string | undefined {
    if (typeof presentedKey !== "string") return undefined;
    let digest: Buffer;
    try {
      digest = sha256(presentedKey);
    } catch {
      return undefined;
    }
    let match: number | undefined;
    // Compare against every stored hash; no early exit on a match.
    for (let i = 0; i < this.#hashes.length; i++) {
      const equal = timingSafeEqual(digest, this.#hashes[i] as Buffer);
      if (equal && match === undefined) match = i;
    }
    return match === undefined ? undefined : this.#names[match];
  }

  clients(): readonly string[] {
    return this.#names;
  }
}

/**
 * Validate client-keys file contents and build the registry. Rejects a blank
 * file, non-JSON, a non-array top level, an empty list, and any entry with an
 * unknown or missing field, a bad client name, a malformed hash, or a client
 * or hash already used by an earlier entry.
 */
export function parseClientRegistry(contents: string): ClientRegistry {
  if (contents.trim().length === 0) throw invalid("the file is empty");

  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    throw invalid("the file is not valid JSON");
  }
  if (!Array.isArray(parsed)) throw invalid("expected a JSON array of client registrations");
  if (parsed.length === 0) throw invalid("expected at least one client registration");

  const names: string[] = [];
  const hashes: Buffer[] = [];
  const clientPositions = new Map<string, number>();
  const hashPositions = new Map<string, number>();

  parsed.forEach((entry: unknown, index) => {
    const position = index + 1;
    const at = `entry ${position}`;
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw invalid(`${at} is not an object`);
    }
    const record = entry as Record<string, unknown>;
    for (const field of Object.keys(record)) {
      if (!ALLOWED_FIELDS.has(field)) throw invalid(`${at} has an unknown field`);
    }

    const client = record.client;
    if (typeof client !== "string" || !CLIENT_NAME_PATTERN.test(client)) {
      throw invalid(`${at} has a missing or invalid "client" (expected ^[a-z][a-z0-9-]{0,31}$)`);
    }
    const keySha256 = record.key_sha256;
    if (typeof keySha256 !== "string" || !KEY_SHA256_PATTERN.test(keySha256)) {
      throw invalid(`${at} has a missing or invalid "key_sha256" (expected 64 lowercase hex characters)`);
    }

    const priorClient = clientPositions.get(client);
    if (priorClient !== undefined) {
      throw invalid(`${at} is a duplicate client of entry ${priorClient}`);
    }
    const priorHash = hashPositions.get(keySha256);
    if (priorHash !== undefined) {
      throw invalid(`${at} has a duplicate key_sha256 of entry ${priorHash}`);
    }
    clientPositions.set(client, position);
    hashPositions.set(keySha256, position);
    names.push(client);
    hashes.push(Buffer.from(keySha256, "hex"));
  });

  return new HashedClientRegistry(names, hashes);
}

/**
 * Load and validate the client-keys file at `path`. A missing or unreadable
 * file is a typed validation error that names the setting, not the path.
 */
export function loadClientRegistryFromFile(
  path: string,
  readFile: ClientKeysFileReader = (p) => readFileSync(p),
): ClientRegistry {
  let raw: Buffer | string;
  try {
    raw = readFile(path);
  } catch {
    throw invalid("the file could not be read");
  }
  return parseClientRegistry(typeof raw === "string" ? raw : raw.toString("utf8"));
}

/**
 * Resolve `TESSERA_CLIENT_KEYS_FILE` from `env` and load the registry. An
 * unset or blank setting is a typed validation error, never "allow all".
 */
export function loadClientRegistry(
  env: NodeJS.ProcessEnv = process.env,
  readFile?: ClientKeysFileReader,
): ClientRegistry {
  return loadClientRegistryFromFile(resolveClientKeysFile(env), readFile);
}
