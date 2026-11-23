export type Identity = "app" | "user";
export type AccessLevel = "read" | "write";
export interface TokenRequest {
  identity: Identity;
  repo?: string;
  access: AccessLevel;
  refresh?: boolean;
  subject?: string;
}
export interface CommitIdentity { name: string; email: string }
export interface Entitlement {
  token: string;
  expires_at: string | null;
  identity: string;
  commit_identity: CommitIdentity | null;
  access: AccessLevel;
  repo: string | null;
}
export type ProviderIssueRequest = TokenRequest;
export interface ProviderIssueResult {
  token: string;
  expiresAt: string | null;
  identity: string;
  commitIdentity: CommitIdentity | null;
  access: AccessLevel;
  repo: string | null;
  cache: "hit" | "miss" | "n/a";
  degradedReason?: "provider_unavailable";
}
export interface ProviderStatus {
  /** Optional in-memory marker changed by the provider when it replaces a credential. */
  credentialRevision?: object;
  provider: string;
  state: "ok" | "unconfigured" | "degraded" | "invalid";
  login: string | null;
  credential_expires_at: string | null;
  expiry_warning: boolean;
  last_error: string | null;
}
export interface CredentialProvider {
  readonly id: string;
  readonly identity: Identity;
  start(): Promise<void>;
  issue(request: ProviderIssueRequest): Promise<ProviderIssueResult>;
  status(): ProviderStatus;
  cacheSize?(): number;
  /**
   * Optional async re-check run before each provider-health poll, so a status
   * read from stored state still reflects the credential the next issuance
   * would see (e.g. a removed or revoked operator token). Must not throw
   * credential material; rejections are ignored.
   */
  refresh?(): Promise<void>;
}
const ERRORS = {
  unauthorized: [401, "Client authentication required"],
  invalid_request: [400, "Invalid token request"],
  policy_denied: [403, "Request denied by policy"],
  repo_not_installed: [422, "App is not installed on the requested repository"],
  provider_unconfigured: [503, "Provider is not configured"],
  credential_invalid: [503, "Provider credential is invalid"],
  provider_unavailable: [503, "Provider is temporarily unavailable"],
  mint_failed: [502, "Provider could not issue a token"],
} as const;
export type TesseraErrorCode = keyof typeof ERRORS;
export function isTesseraErrorCode(code: unknown): code is TesseraErrorCode {
  return typeof code === "string" && Object.hasOwn(ERRORS, code);
}
/** Messages are fixed; upstream exceptions and response bodies never cross this boundary. */
export class TesseraError extends Error {
  readonly status: number;
  constructor(readonly code: TesseraErrorCode) {
    super(ERRORS[code][1]);
    this.name = "TesseraError";
    this.status = ERRORS[code][0];
  }
}
export const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
export function parseTokenRequest(body: unknown): TokenRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new TesseraError("invalid_request");
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some(key => !["identity", "repo", "access", "refresh", "subject"].includes(key)) ||
    !["app", "user"].includes(value.identity as string) || !["read", "write"].includes(value.access as string) ||
    (value.identity === "app" && value.repo === undefined) ||
    (value.repo !== undefined && (typeof value.repo !== "string" || !REPO_PATTERN.test(value.repo))) ||
    (value.refresh !== undefined && typeof value.refresh !== "boolean") ||
    (value.subject !== undefined && typeof value.subject !== "string")) throw new TesseraError("invalid_request");
  return { ...value } as unknown as TokenRequest;
}
/** One grant a client holds, as `GET /v1/client` reports it to that client. */
export interface ClientGrant {
  readonly identity: Identity;
  readonly access: "read" | "write";
  /** Lowercased `owner/name` or `owner/*` entries; empty for the user identity. */
  readonly repos: string[];
}
export interface AuthorizationBoundary {
  authenticate(authorization: string | undefined): string | Promise<string>;
  authorize(caller: string, request: TokenRequest): void | Promise<void>;
  /** The authenticated caller's own grants (never another client's). Absent = none. */
  grants?(caller: string): ClientGrant[];
}
export const denyAuthorization: AuthorizationBoundary = {
  authenticate() { throw new TesseraError("unauthorized"); },
  authorize() { throw new TesseraError("policy_denied"); },
};
export class UnconfiguredProvider implements CredentialProvider {
  readonly id: string;
  constructor(readonly identity: Identity) { this.id = `github-${identity}`; }
  async start(): Promise<void> {}
  async issue(): Promise<ProviderIssueResult> { throw new TesseraError("provider_unconfigured"); }
  status(): ProviderStatus { return { provider: this.id, state: "unconfigured", login: null, credential_expires_at: null, expiry_warning: false, last_error: null }; }
}
export class ProviderRegistry {
  private readonly providers = new Map<Identity, CredentialProvider>();
  constructor(providers: CredentialProvider[] = []) {
    for (const provider of providers) {
      if (this.providers.has(provider.identity)) throw new Error("Duplicate provider identity");
      this.providers.set(provider.identity, provider);
    }
    for (const identity of ["app", "user"] as const) if (!this.providers.has(identity)) this.providers.set(identity, new UnconfiguredProvider(identity));
  }
  select(identity: Identity): CredentialProvider { return this.providers.get(identity)!; }
  all(): CredentialProvider[] { return [...this.providers.values()]; }
}
const READ = Object.freeze({ metadata: "read", contents: "read", pull_requests: "read", issues: "read", checks: "read", statuses: "read" });
export const ACCESS_PROFILES = Object.freeze({ read: READ, write: Object.freeze({ ...READ, contents: "write", pull_requests: "write", issues: "write" }) });
