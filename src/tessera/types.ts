/**
 * Tessera credential-entitlement wire types, provider seam and typed errors.
 *
 * Tessera is the one place a March process obtains a GitHub credential. These
 * shapes mirror the US1 contracts (`POST /v1/github/token`, `/status`, the
 * provider interface). Client-key authentication (US2, `unauthorized`) and the
 * per-client policy (US2, `policy_denied`) are typed here; the `user` provider
 * (US7) plugs in behind the same shapes later.
 */

/**
 * Header carrying the caller's slice id, for span correlation only: the
 * client sends it and the server nests its `tessera.issue` span under that
 * slice's trace, for an authenticated request only. Lives here so neither module imports the other.
 */
export const TESSERA_SLICE_ID_HEADER = "x-march-slice-id";

/** Which credential a request asks for: the bot installation token or the operator PAT. */
export type Identity = "app" | "user";

/** Requested access level; mapped to a fixed permission set by {@link ACCESS_PROFILES}. */
export type AccessLevel = "read" | "write";

/** Provider ids; one per identity in v1. */
export type ProviderId = "github-app" | "github-user";

/** Whether an issuance was served from the token cache (span/audit attribute). */
export type CacheOutcome = "hit" | "miss" | "n/a";

/** Body of `POST /v1/github/token` (data model "Entitlement Request"). */
export interface EntitlementRequest {
  readonly identity: Identity;
  /** `owner/name`; required for `app`. */
  readonly repo?: string;
  readonly access: AccessLevel;
  /** Evict the matching cache entry before issuing. */
  readonly refresh?: boolean;
  /** Reserved for per-spawn tickets; audited only, never used for a decision. */
  readonly subject?: string;
}

/** Bot author/committer identity for commits made with an `app` token. */
export interface CommitIdentity {
  readonly name: string;
  readonly email: string;
}

/** Successful `POST /v1/github/token` response body (data model "Entitlement"). */
export interface Entitlement {
  /** The credential. Never logged. */
  readonly token: string;
  /** RFC 3339; `null` only for a `user` token with no discoverable expiry. */
  readonly expires_at: string | null;
  /** Login the token acts as. */
  readonly identity: string;
  /** `null` for `user`. */
  readonly commit_identity: CommitIdentity | null;
  readonly access: AccessLevel;
  /** `null` for `user`. */
  readonly repo: string | null;
}

/** A request handed to a provider; already validated and allowed by the caller's policy rule. */
export interface ProviderIssueRequest {
  readonly repo?: string;
  readonly access: AccessLevel;
  readonly refresh?: boolean;
}

/** What a provider returns for a successful issuance. */
export interface ProviderIssueResult {
  readonly token: string;
  readonly expiresAt: string | null;
  readonly identity: string;
  readonly commitIdentity: CommitIdentity | null;
  readonly cache: CacheOutcome;
}

/** Provider lifecycle state (data model "Provider Status lifecycle"). */
export type ProviderState = "ok" | "unconfigured" | "degraded" | "invalid";

/** One provider's entry in `/status` (data model "Provider Status"). Never carries secrets. */
export interface ProviderStatus {
  readonly provider: ProviderId;
  readonly state: ProviderState;
  readonly login: string | null;
  readonly credential_expires_at: string | null;
  readonly expiry_warning: boolean;
  /** Error class only; no token or key material. */
  readonly last_error: string | null;
}

/** The seam the token route dispatches through. Providers never decide policy. */
export interface CredentialProvider {
  readonly id: ProviderId;
  readonly identity: Identity;
  /** Derive the login; never throws on a GitHub outage. */
  start(): Promise<void>;
  /** Issue a credential, or throw a {@link TesseraError}. */
  issue(req: ProviderIssueRequest): Promise<ProviderIssueResult>;
  status(): ProviderStatus;
  /** Number of cached credentials this provider holds; omitted means 0. Count only. */
  cacheEntries?(): number;
}

/** GitHub App permission value. */
export type PermissionLevel = "read" | "write";

/** The `permissions` object sent to GitHub when minting an installation token. */
export type GitHubPermissions = Readonly<Record<string, PermissionLevel>>;

const READ_PROFILE: GitHubPermissions = Object.freeze({
  metadata: "read",
  contents: "read",
  pull_requests: "read",
  issues: "read",
  checks: "read",
  statuses: "read",
});

/**
 * The fixed Access Profile map (data model "Access Profile"). It is the only
 * source of the permissions sent to GitHub; callers cannot name permissions.
 * `write` is a superset of `read` and excludes `workflows`, `administration`
 * and `members` (`workflows` pending spec SD-005).
 */
export const ACCESS_PROFILES: Readonly<Record<AccessLevel, GitHubPermissions>> = Object.freeze({
  read: READ_PROFILE,
  write: Object.freeze({
    ...READ_PROFILE,
    contents: "write",
    pull_requests: "write",
    issues: "write",
  }),
});

/**
 * Stable error codes Tessera can return. `internal` covers unexpected failures.
 * `unauthorized` is the US2 client-key rejection; `policy_denied` is the US2
 * default-deny policy rejection.
 */
export type TesseraErrorCode =
  | "unauthorized"
  | "policy_denied"
  | "invalid_request"
  | "repo_not_installed"
  | "provider_unconfigured"
  | "credential_invalid"
  | "provider_unavailable"
  | "mint_failed"
  | "internal";

/** Uniform error envelope returned on every non-2xx Tessera response. */
export interface TesseraErrorBody {
  readonly error: {
    readonly code: TesseraErrorCode;
    readonly message: string;
  };
}

/** Base class of every typed Tessera error: a contract code plus its HTTP status. */
export abstract class TesseraError extends Error {
  abstract readonly code: TesseraErrorCode;
  abstract readonly status: number;
}

/** Malformed request or invalid configuration value. HTTP 400 `invalid_request`. */
export class TesseraValidationError extends TesseraError {
  readonly code = "invalid_request" satisfies TesseraErrorCode;
  readonly status = 400;

  constructor(message: string) {
    super(message);
    this.name = "TesseraValidationError";
  }
}

/**
 * The one fixed `unauthorized` message. It never distinguishes a missing,
 * malformed or unknown key, and never echoes what was presented.
 */
export const UNAUTHORIZED_MESSAGE = "A valid Tessera client key is required.";

/** Missing, malformed or unknown client key. HTTP 401 `unauthorized`. */
export class UnauthorizedError extends TesseraError {
  readonly code = "unauthorized" satisfies TesseraErrorCode;
  readonly status = 401;

  constructor() {
    super(UNAUTHORIZED_MESSAGE);
    this.name = "UnauthorizedError";
  }
}

/** The policy dimension a request was denied on. */
export type PolicyDimension = "identity" | "repository" | "access";

/**
 * The one fixed `policy_denied` message per dimension. Each names only the
 * dimension denied, never the client's allowlist or the submitted values.
 */
export const POLICY_DENIED_MESSAGES: Readonly<Record<PolicyDimension, string>> = Object.freeze({
  identity: "The requested identity is not granted to this client.",
  repository: "The requested repository is not allowed for this client.",
  access: "The requested access exceeds this client's ceiling.",
});

/** Identity, repository or access outside the client's policy. HTTP 403 `policy_denied`. */
export class PolicyDeniedError extends TesseraError {
  readonly code = "policy_denied" satisfies TesseraErrorCode;
  readonly status = 403;
  readonly dimension: PolicyDimension;

  constructor(dimension: PolicyDimension) {
    super(POLICY_DENIED_MESSAGES[dimension]);
    this.name = "PolicyDeniedError";
    this.dimension = dimension;
  }
}

/** App not installed on the repo's owner or repo. HTTP 422; scope is never widened. */
export class RepoNotInstalledError extends TesseraError {
  readonly code = "repo_not_installed" satisfies TesseraErrorCode;
  readonly status = 422;

  constructor(message: string) {
    super(message);
    this.name = "RepoNotInstalledError";
  }
}

/** No provider configured for the identity. HTTP 503 `provider_unconfigured`. */
export class ProviderUnconfiguredError extends TesseraError {
  readonly code = "provider_unconfigured" satisfies TesseraErrorCode;
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "ProviderUnconfiguredError";
  }
}

/** GitHub rejected the credential, or the PAT expired. HTTP 503 `credential_invalid`. */
export class CredentialInvalidError extends TesseraError {
  readonly code = "credential_invalid" satisfies TesseraErrorCode;
  readonly status = 503;

  constructor(message: string) {
    super(message);
    this.name = "CredentialInvalidError";
  }
}

/** Default `Retry-After` for `provider_unavailable`, in seconds. */
export const DEFAULT_RETRY_AFTER_SECONDS = 30;

/** GitHub unreachable or 5xx with no usable cached token. HTTP 503 with `Retry-After`. */
export class ProviderUnavailableError extends TesseraError {
  readonly code = "provider_unavailable" satisfies TesseraErrorCode;
  readonly status = 503;
  readonly retryAfterSeconds: number;

  constructor(message: string, retryAfterSeconds: number = DEFAULT_RETRY_AFTER_SECONDS) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/** Any other mint failure. HTTP 502 `mint_failed`. */
export class MintFailedError extends TesseraError {
  readonly code = "mint_failed" satisfies TesseraErrorCode;
  readonly status = 502;

  constructor(message: string) {
    super(message);
    this.name = "MintFailedError";
  }
}
