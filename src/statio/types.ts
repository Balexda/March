/**
 * Statio forge-gateway wire types and client-facing contracts.
 *
 * Statio is the async HTTP boundary between March consumers and forge reads.
 * These shapes mirror the US5 contracts and are intentionally transport-only:
 * no current `gh` consumer is cut over by this slice. US3 adds the in-process
 * `gh repo view` read seam (see `adapter.ts`) behind the same `RepoInfo` shape.
 */

/** Repository identity resolved from `gh repo view`. */
export interface RepoInfo {
  /** Repository owner/name, e.g. `Balexda/March`. */
  readonly owner: string;
  /** Default branch name, e.g. `main`. */
  readonly defaultBranch: string;
}

export type ListPrsState = "open" | "closed" | "merged" | "all";

export interface ListPrsRequest {
  readonly head?: string;
  readonly author?: string;
  readonly state?: ListPrsState;
}

export type CheckRollup = "NONE" | "FAIL" | "PENDING" | "PASS";

export interface CheckSummary {
  readonly name: string;
  readonly conclusion: string;
  readonly url: string | null;
}

export interface ReviewThread {
  readonly id: number;
  readonly path?: string;
  readonly line?: number;
  readonly author?: string;
  readonly bodyPreview: string;
  readonly lastAuthor?: string;
  readonly lastCommentAt?: string;
  readonly commentCount: number;
  readonly commentIds: number[];
  readonly needsResponse?: boolean;
}

export interface PullRequestListItem {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly mergeable?: string;
  readonly headBranch: string;
  readonly title: string;
  readonly checks?: CheckRollup;
  readonly createdAt: string;
}

export interface PullRequestSummary {
  readonly number: number;
  readonly url: string;
  readonly state: string;
  readonly mergeable: string;
  readonly reviewDecision?: string;
  readonly headBranch: string;
  readonly title: string;
  readonly author: string;
  readonly checks: CheckRollup;
  readonly failedChecks: CheckSummary[];
  readonly unresolvedThreads: ReviewThread[];
  readonly threadCount: number;
  readonly needsResponseCount: number;
}

/** Stable error codes returned in Statio's uniform error envelope. */
export type ForgeErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "forge_error"
  | "internal";

/** Uniform error envelope returned on every non-2xx Statio response. */
export interface ForgeErrorBody {
  readonly error: {
    readonly code: ForgeErrorCode;
    readonly message: string;
  };
}

/** Consumer seam for Statio forge reads. */
export interface ForgeClient {
  repoInfo(): Promise<RepoInfo>;
  listPrs(req: ListPrsRequest): Promise<PullRequestListItem[]>;
  getPr(number: number): Promise<PullRequestSummary>;
  reviewThreads(prNumber: number): Promise<ReviewThread[]>;
  reachable(): Promise<boolean>;
}

export class StatioValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StatioValidationError";
  }
}

/** A forge dependency failure. Maps to HTTP 502 `forge_error`. */
export class StatioForgeError extends Error {
  readonly code = "forge_error" satisfies ForgeErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "StatioForgeError";
  }
}

/** A requested forge resource was absent. Maps to HTTP 404 `not_found`. */
export class StatioNotFoundError extends Error {
  readonly code = "not_found" satisfies ForgeErrorCode;

  constructor(message: string) {
    super(message);
    this.name = "StatioNotFoundError";
  }
}
