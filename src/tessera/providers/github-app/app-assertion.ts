/**
 * GitHub App assertion signer.
 *
 * Produces the short-lived RS256 JWT GitHub requires to authenticate as the
 * app (before minting installation tokens), using `node:crypto` only — the
 * repository carries no JWT dependency.
 *
 * Key handling: the private key is read from the configured key file and held
 * as a `KeyObject`. Failures to read or parse it surface as
 * {@link CredentialInvalidError} with fixed, operator-readable text that names
 * the setting only. Error messages are returned to HTTP callers verbatim, so
 * they never include the file path, its contents, or the underlying error.
 */
import { createPrivateKey, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { TESSERA_GITHUB_APP_KEY_FILE_ENV } from "../../config.js";
import { CredentialInvalidError } from "../../types.js";

/** Seconds `iat` is backdated to tolerate clock skew between Tessera and GitHub. */
export const APP_ASSERTION_BACKDATE_SECONDS = 60;

/** Seconds after now the assertion expires; under GitHub's ten-minute cap. */
export const APP_ASSERTION_LIFETIME_SECONDS = 9 * 60;

/** Millisecond wall clock; injectable for tests. */
export type Clock = () => number;

const UNREADABLE_KEY_MESSAGE = `GitHub App private key could not be read; check ${TESSERA_GITHUB_APP_KEY_FILE_ENV}.`;
const INVALID_KEY_MESSAGE = `GitHub App private key is not a valid RSA private key; check ${TESSERA_GITHUB_APP_KEY_FILE_ENV}.`;

/** Reads a key file's raw bytes; injectable for tests. */
export type KeyFileReader = (path: string) => Buffer | string;

/**
 * Load the GitHub App private key from `keyFile`. An unreadable file, or
 * contents that are not an RSA private key, raise {@link CredentialInvalidError}.
 */
export function loadAppPrivateKey(
  keyFile: string,
  readFile: KeyFileReader = (path) => readFileSync(path),
): KeyObject {
  let pem: Buffer | string;
  try {
    pem = readFile(keyFile);
  } catch {
    throw new CredentialInvalidError(UNREADABLE_KEY_MESSAGE);
  }

  let key: KeyObject;
  try {
    key = createPrivateKey(pem);
  } catch {
    throw new CredentialInvalidError(INVALID_KEY_MESSAGE);
  }
  if (key.asymmetricKeyType !== "rsa") {
    throw new CredentialInvalidError(INVALID_KEY_MESSAGE);
  }
  return key;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

/** Inputs to {@link signAppAssertion}. */
export interface SignAppAssertionOptions {
  readonly appId: string;
  readonly privateKey: KeyObject;
  readonly now?: Clock;
}

/**
 * Sign a GitHub App assertion: `iss` = app id, `iat` backdated by
 * {@link APP_ASSERTION_BACKDATE_SECONDS}, `exp` {@link APP_ASSERTION_LIFETIME_SECONDS}
 * after now. Returns the compact JWT.
 */
export function signAppAssertion({ appId, privateKey, now = Date.now }: SignAppAssertionOptions): string {
  const nowSeconds = Math.floor(now() / 1000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - APP_ASSERTION_BACKDATE_SECONDS,
    exp: nowSeconds + APP_ASSERTION_LIFETIME_SECONDS,
    iss: appId,
  });
  const signingInput = `${header}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(signingInput, "utf8"), privateKey).toString("base64url");
  return `${signingInput}.${signature}`;
}

/** Inputs to {@link createAppAssertionSigner}. */
export interface AppAssertionSignerOptions {
  readonly appId: string;
  readonly keyFile: string;
  readonly now?: Clock;
  readonly readFile?: KeyFileReader;
}

/** Returns a fresh app assertion on each call. */
export type AppAssertionSigner = () => string;

/**
 * Load the key from `keyFile` once and return a signer that mints a fresh
 * assertion per call. A bad key raises {@link CredentialInvalidError} here.
 */
export function createAppAssertionSigner({
  appId,
  keyFile,
  now = Date.now,
  readFile,
}: AppAssertionSignerOptions): AppAssertionSigner {
  const privateKey = loadAppPrivateKey(keyFile, readFile);
  return () => signAppAssertion({ appId, privateKey, now });
}
