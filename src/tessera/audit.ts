/**
 * The Issuance Audit Record (data model entity 10): one `tessera.audit` log
 * event per `POST /v1/github/token` request, whatever its outcome.
 *
 * The server fills an {@link AuditContext} progressively as a request is
 * resolved; {@link buildAuditRecord} then copies a fixed allow-list of fields
 * out of it. Fields are copied one by one, never spread, so nothing added to
 * the context — or to the object passed in — can reach the event unless the
 * builder names it. No field ever carries a token, a client key, a key hash,
 * a request header or the request body.
 */
import type {
  AccessLevel,
  CacheOutcome,
  Identity,
  ProviderId,
  TesseraErrorCode,
} from "./types.js";

/** Audit `outcome`: issued, rejected by the caller's fault (4xx), or failed (5xx). */
export type AuditOutcome = "issued" | "denied" | "failed";

/** Caller recorded for a request that never authenticated. */
export const UNKNOWN_CALLER = "unknown";

/**
 * Longest `subject` the record echoes. The request validator accepts any
 * string, so the audit bounds it rather than logging an unbounded
 * caller-supplied value; a longer subject is truncated.
 */
export const AUDIT_SUBJECT_MAX_LENGTH = 256;

/** What a token request resolved before it was answered or rejected. */
export interface AuditContext {
  /** Authenticated client name; `null` until the key is accepted. */
  caller: string | null;
  identity: Identity | null;
  /** The requested `owner/name`, as validated; `null` when absent or unresolved. */
  repo: string | null;
  access: AccessLevel | null;
  subject: string | null;
  /** The provider the request was dispatched to; `null` if none was reached. */
  provider: ProviderId | null;
  /** Cache result of an issued token; `null` until (and unless) a token is issued. */
  cache: CacheOutcome | null;
  /** Expiry of an issued token. */
  expiresAt: string | null;
  /** The error code the request was answered with, if it was rejected. */
  errorCode: TesseraErrorCode | null;
  /** Set once the request's record has been emitted, so it is emitted at most once. */
  emitted: boolean;
}

/** The `tessera.audit` event body — exactly the data model's fields. */
export interface AuditRecord {
  readonly caller: string;
  readonly identity: Identity | null;
  readonly provider: ProviderId | null;
  readonly repo: string | null;
  readonly access: AccessLevel | null;
  readonly outcome: AuditOutcome;
  readonly reason: TesseraErrorCode | null;
  readonly cache: CacheOutcome;
  readonly expires_at: string | null;
  readonly subject: string | null;
}

/** A fresh context for one token request: nothing resolved yet. */
export function createAuditContext(): AuditContext {
  return {
    caller: null,
    identity: null,
    repo: null,
    access: null,
    subject: null,
    provider: null,
    cache: null,
    expiresAt: null,
    errorCode: null,
    emitted: false,
  };
}

function capSubject(subject: string | null): string | null {
  if (subject === null || subject.length <= AUDIT_SUBJECT_MAX_LENGTH) return subject;
  const cut = subject.slice(0, AUDIT_SUBJECT_MAX_LENGTH);
  // Never end on half of a surrogate pair.
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Build the audit record for a request answered with `statusCode`.
 *
 * Outcome rule — working default for open debt SD-021 option (a), by status
 * class: a 2xx with an issued token is `issued`; every other 4xx (including
 * `unauthorized`, `invalid_request` and `repo_not_installed`) is `denied`;
 * everything else is `failed`. `reason` is the error code, `null` only when
 * issued. `cache` is `hit`/`miss` only when issued, else `n/a`.
 */
export function buildAuditRecord(context: AuditContext, statusCode: number): AuditRecord {
  const issued = statusCode >= 200 && statusCode < 300 && context.cache !== null;
  const outcome: AuditOutcome = issued
    ? "issued"
    : statusCode >= 400 && statusCode < 500
      ? "denied"
      : "failed";
  return {
    caller: context.caller ?? UNKNOWN_CALLER,
    identity: context.identity,
    provider: context.provider,
    repo: context.repo,
    access: context.access,
    outcome,
    reason: issued
      ? null
      : (context.errorCode ?? (outcome === "denied" ? "invalid_request" : "internal")),
    cache: issued ? (context.cache ?? "n/a") : "n/a",
    expires_at: issued ? context.expiresAt : null,
    subject: capSubject(context.subject),
  };
}
