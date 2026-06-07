/**
 * Statio forge-gateway wire types and client-facing contracts.
 *
 * Statio is the async HTTP boundary between March consumers and forge reads.
 * These shapes mirror the US5 contracts and are intentionally transport-only:
 * no current `gh` consumer is cut over by this slice.
 */

export interface RepoInfo {
  readonly owner: string;
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

export type ForgeErrorCode =
  | "invalid_request"
  | "unauthorized"
  | "not_found"
  | "forge_error"
  | "internal";

export interface ForgeErrorBody {
  readonly error: {
    readonly code: ForgeErrorCode;
    readonly message: string;
  };
}

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
