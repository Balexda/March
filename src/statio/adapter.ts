import { execFile } from "node:child_process";
import type {
  CheckRollup,
  CheckSummary,
  RepoInfo,
  ForgeClient,
  ListPrsRequest,
  PullRequestListItem,
  PullRequestSummary,
  ReviewThread,
} from "./types.js";
import { StatioForgeError, StatioNotFoundError, StatioValidationError } from "./types.js";

const EXEC_MAX_BUFFER = 1024 * 1024;
const DEFAULT_GH_TIMEOUT_MS = 10_000;

export interface StatioCommandOptions {
  readonly cwd?: string;
  readonly timeoutMs: number;
}

export type StatioCommandRunner = (
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
) => Promise<string>;

export interface GhForgeAdapterOptions {
  readonly cwd?: string;
  readonly timeoutMs?: number;
  readonly runCommand?: StatioCommandRunner;
}

export function buildRepoInfoArgs(): string[] {
  return ["repo", "view", "--json", "nameWithOwner,defaultBranchRef"];
}

export function buildPrViewArgs(number: number, owner?: string): string[] {
  const args = [
    "pr",
    "view",
    String(number),
    "--json",
    "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
  ];
  if (owner) {
    args.push("-R", owner);
  }
  return args;
}

const PR_LIST_JSON_FIELDS =
  "number,url,state,mergeable,headRefName,title,statusCheckRollup,createdAt";

export function buildPrListArgs(req: ListPrsRequest, owner?: string): string[] {
  const args = ["pr", "list", "--json", PR_LIST_JSON_FIELDS];
  if (req.head) {
    args.push("--head", req.head);
  }
  if (req.author) {
    args.push("--author", req.author);
  }
  args.push("--state", req.state ?? "open");
  if (owner) {
    args.push("-R", owner);
  }
  return args;
}

export function buildReviewThreadsArgs(owner: string, number: number): string[] {
  const [repoOwner, repoName] = owner.split("/");
  return [
    "api",
    "graphql",
    "-F",
    `owner=${repoOwner}`,
    "-F",
    `name=${repoName}`,
    "-F",
    `pr=${number}`,
    "-f",
    `query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes {
              databaseId
              body
              path
              line
              author { login }
              createdAt
            }
          }
        }
      }
    }
  }
}`,
  ];
}

/**
 * Normalize `gh`'s `nameWithOwner` to the data model's `owner` field.
 *
 * The data model permits an empty `owner` as the documented "owner unavailable"
 * fallback signal, and treats an owner that is not splittable into `owner/name`
 * as unavailable downstream rather than a hard failure. A missing, empty, or
 * unsplittable value therefore normalizes to `""` instead of throwing.
 */
function normalizeOwner(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const slash = value.indexOf("/");
  if (slash <= 0 || slash === value.length - 1) {
    return "";
  }
  return value;
}

export function parseRepoInfoGhJson(text: string): RepoInfo {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StatioForgeError("gh repo view returned unparseable repository metadata.");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StatioForgeError("gh repo view returned malformed repository metadata.");
  }
  const record = parsed as Record<string, unknown>;
  const owner = normalizeOwner(record.nameWithOwner);
  const defaultBranchRef = record.defaultBranchRef;
  const defaultBranch =
    defaultBranchRef && typeof defaultBranchRef === "object" && !Array.isArray(defaultBranchRef)
      ? (defaultBranchRef as Record<string, unknown>).name
      : undefined;

  if (typeof defaultBranch !== "string" || defaultBranch.length === 0) {
    throw new StatioForgeError("gh repo view did not return a default branch.");
  }

  return { owner, defaultBranch };
}

const FAILED_CONCLUSIONS = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"]);
const PENDING_STATUSES = new Set(["IN_PROGRESS", "QUEUED", "PENDING"]);

function checksSummary(statusCheckRollup: unknown): CheckRollup {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (checks.length === 0) return "NONE";
  if (
    checks.some(
      (check) =>
        check &&
        typeof check === "object" &&
        FAILED_CONCLUSIONS.has(String((check as Record<string, unknown>).conclusion)),
    )
  ) {
    return "FAIL";
  }
  if (
    checks.some(
      (check) =>
        check &&
        typeof check === "object" &&
        PENDING_STATUSES.has(String((check as Record<string, unknown>).status)),
    )
  ) {
    return "PENDING";
  }
  return "PASS";
}

function failedChecks(statusCheckRollup: unknown): CheckSummary[] {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  return checks
    .filter(
      (check) =>
        check &&
        typeof check === "object" &&
        FAILED_CONCLUSIONS.has(String((check as Record<string, unknown>).conclusion)),
    )
    .map((check) => {
      const record = check as Record<string, unknown>;
      return {
        name: String(record.name || record.context || "unknown"),
        conclusion: String(record.conclusion || "FAILURE"),
        url:
          typeof record.detailsUrl === "string"
            ? record.detailsUrl
            : typeof record.targetUrl === "string"
              ? record.targetUrl
              : null,
      };
    });
}

function parseJsonObject(text: string, message: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StatioForgeError(message);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new StatioForgeError(message);
  }
  return parsed as Record<string, unknown>;
}

function stringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  return typeof value === "string" ? value : "";
}

function parseReviewThreadsGhJson(text: string): ReviewThread[] {
  const parsed = parseJsonObject(text, "gh api graphql returned unparseable review threads.");
  const pullRequest = ((parsed.data as Record<string, unknown> | undefined)?.repository as
    | Record<string, unknown>
    | undefined)?.pullRequest as Record<string, unknown> | undefined;
  if (!pullRequest || typeof pullRequest !== "object" || Array.isArray(pullRequest)) {
    throw new StatioForgeError("gh api graphql returned malformed review threads.");
  }
  const reviewThreads = pullRequest.reviewThreads as Record<string, unknown> | undefined;
  if (!reviewThreads || !Array.isArray(reviewThreads.nodes)) {
    throw new StatioForgeError("gh api graphql returned malformed review threads.");
  }
  const nodes = reviewThreads.nodes;
  return nodes
    .filter(
      (thread) =>
        thread &&
        typeof thread === "object" &&
        (thread as Record<string, unknown>).isResolved === false,
    )
    .map((thread) => {
      const commentsField = (thread as Record<string, unknown>).comments as
        | Record<string, unknown>
        | undefined;
      const comments = Array.isArray(commentsField?.nodes)
        ? [...commentsField.nodes].sort((a, b) =>
            String((a as Record<string, unknown>)?.createdAt).localeCompare(
              String((b as Record<string, unknown>)?.createdAt),
            ),
          )
        : [];
      const first = (comments[0] ?? {}) as Record<string, unknown>;
      const last = (comments[comments.length - 1] ?? first) as Record<string, unknown>;
      return {
        id: Number(first.databaseId),
        path: typeof first.path === "string" ? first.path : undefined,
        line: typeof first.line === "number" ? first.line : undefined,
        author:
          typeof (first.author as Record<string, unknown> | undefined)?.login === "string"
            ? ((first.author as Record<string, unknown>).login as string)
            : undefined,
        bodyPreview: String(first.body || "").slice(0, 140),
        lastAuthor:
          typeof (last.author as Record<string, unknown> | undefined)?.login === "string"
            ? ((last.author as Record<string, unknown>).login as string)
            : undefined,
        lastCommentAt: typeof last.createdAt === "string" ? last.createdAt : undefined,
        commentCount: comments.length,
        commentIds: comments
          .map((comment) => (comment as Record<string, unknown>).databaseId)
          .filter((id): id is number => typeof id === "number"),
      };
    })
    .filter((thread) => Number.isFinite(thread.id));
}

export function parsePullRequestSummaryGhJson(
  text: string,
  unresolvedThreads: readonly ReviewThread[] = [],
): PullRequestSummary {
  const parsed = parseJsonObject(text, "gh pr view returned unparseable pull request data.");
  const number = parsed.number;
  const url = stringField(parsed, "url");
  const state = stringField(parsed, "state");
  const mergeable = stringField(parsed, "mergeable");
  const headBranch = stringField(parsed, "headRefName");
  const title = stringField(parsed, "title");
  const authorRecord = parsed.author as Record<string, unknown> | undefined;
  const author = typeof authorRecord?.login === "string" ? authorRecord.login : "";
  if (typeof number !== "number" || !Number.isInteger(number) || !url || !state || !headBranch) {
    throw new StatioForgeError("gh pr view returned malformed pull request data.");
  }
  const annotated = unresolvedThreads.map((thread) => ({
    ...thread,
    needsResponse: thread.lastAuthor !== author,
  }));
  return {
    number,
    url,
    state,
    mergeable,
    reviewDecision: stringField(parsed, "reviewDecision"),
    headBranch,
    title,
    author,
    checks: checksSummary(parsed.statusCheckRollup),
    failedChecks: failedChecks(parsed.statusCheckRollup),
    unresolvedThreads: annotated,
    threadCount: annotated.length,
    needsResponseCount: annotated.filter((thread) => thread.needsResponse).length,
  };
}

function assertPlainObject(value: unknown, message: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatioForgeError(message);
  }
  return value as Record<string, unknown>;
}

export function parsePullRequestListGhJson(text: string): PullRequestListItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new StatioForgeError("gh pr list returned unparseable pull request data.");
  }
  if (!Array.isArray(parsed)) {
    throw new StatioForgeError("gh pr list returned malformed pull request data.");
  }
  return parsed.map((item) => {
    const record = assertPlainObject(item, "gh pr list returned malformed pull request data.");
    const number = record.number;
    const url = stringField(record, "url");
    const state = stringField(record, "state");
    const mergeable = stringField(record, "mergeable");
    const headBranch = stringField(record, "headRefName");
    const title = stringField(record, "title");
    const createdAt = stringField(record, "createdAt");
    if (
      typeof number !== "number" ||
      !Number.isInteger(number) ||
      !url ||
      !state ||
      !headBranch ||
      !title ||
      !createdAt
    ) {
      throw new StatioForgeError("gh pr list returned malformed pull request data.");
    }
    return {
      number,
      url,
      state,
      ...(mergeable ? { mergeable } : {}),
      headBranch,
      title,
      checks: checksSummary(record.statusCheckRollup),
      createdAt,
    };
  });
}

function validateOptionalFilter(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim() !== value || value.length === 0) {
    throw new StatioValidationError(`${field} must be a non-empty string when provided.`);
  }
  return value;
}

function validateListPrsRequest(req: ListPrsRequest): ListPrsRequest {
  if (!req || typeof req !== "object" || Array.isArray(req)) {
    throw new StatioValidationError("listPrs request must be an object.");
  }
  const record = req as Record<string, unknown>;
  const state = record.state;
  if (
    state !== undefined &&
    state !== "open" &&
    state !== "closed" &&
    state !== "merged" &&
    state !== "all"
  ) {
    throw new StatioValidationError(
      "state must be one of open, closed, merged, or all when provided.",
    );
  }
  return {
    head: validateOptionalFilter(record.head, "head"),
    author: validateOptionalFilter(record.author, "author"),
    state: state as ListPrsRequest["state"],
  };
}

function isNotFoundError(err: unknown): boolean {
  const haystack: string[] = [];
  if (err instanceof Error) {
    haystack.push(err.message);
    const streams = err as { stderr?: unknown; stdout?: unknown };
    if (typeof streams.stderr === "string") haystack.push(streams.stderr);
    if (typeof streams.stdout === "string") haystack.push(streams.stdout);
  } else {
    haystack.push(String(err));
  }
  return /not found|no pull request|could not resolve|404/i.test(haystack.join("\n"));
}

function splitOwner(owner: string): [string, string] | null {
  const [repoOwner, repoName, extra] = owner.split("/");
  if (!repoOwner || !repoName || extra) return null;
  return [repoOwner, repoName];
}

export function createGhForgeAdapter(
  options: GhForgeAdapterOptions = {},
): Pick<ForgeClient, "repoInfo" | "listPrs" | "getPr" | "reviewThreads"> {
  const runCommand = options.runCommand ?? execText;
  const timeoutMs = options.timeoutMs ?? DEFAULT_GH_TIMEOUT_MS;

  async function resolveRepoInfo(): Promise<RepoInfo> {
    try {
      const stdout = await runCommand("gh", buildRepoInfoArgs(), {
        cwd: options.cwd,
        timeoutMs,
      });
      return parseRepoInfoGhJson(stdout);
    } catch {
      throw new StatioForgeError("gh repo view failed while resolving repository metadata.");
    }
  }

  return {
    async repoInfo(): Promise<RepoInfo> {
      return resolveRepoInfo();
    },

    async listPrs(req: ListPrsRequest = {}): Promise<PullRequestListItem[]> {
      const filters = validateListPrsRequest(req);
      let repo: RepoInfo = { owner: "", defaultBranch: "" };
      try {
        repo = await resolveRepoInfo();
      } catch {
        repo = { owner: "", defaultBranch: "" };
      }

      const owner = splitOwner(repo.owner) ? repo.owner : "";
      const commandOptions = {
        cwd: owner ? undefined : options.cwd,
        timeoutMs,
      };

      try {
        const stdout = await runCommand("gh", buildPrListArgs(filters, owner), commandOptions);
        return parsePullRequestListGhJson(stdout);
      } catch (err) {
        if (err instanceof StatioValidationError || err instanceof StatioForgeError) {
          throw err;
        }
        throw new StatioForgeError("gh pr list failed while listing pull requests.");
      }
    },

    async getPr(number: number): Promise<PullRequestSummary> {
      if (!Number.isInteger(number) || number <= 0) {
        throw new StatioValidationError(
          `Pull request number must be a positive integer; received ${number}.`,
        );
      }

      let repo: RepoInfo = { owner: "", defaultBranch: "" };
      try {
        repo = await resolveRepoInfo();
      } catch {
        repo = { owner: "", defaultBranch: "" };
      }

      const owner = splitOwner(repo.owner) ? repo.owner : "";
      const commandOptions = {
        cwd: owner ? undefined : options.cwd,
        timeoutMs,
      };

      let prStdout: string;
      try {
        prStdout = await runCommand("gh", buildPrViewArgs(number, owner), commandOptions);
      } catch (err) {
        if (isNotFoundError(err)) {
          throw new StatioNotFoundError(`Pull request #${number} was not found.`);
        }
        throw new StatioForgeError("gh pr view failed while reading pull request state.");
      }

      let threads: ReviewThread[] = [];
      if (owner) {
        try {
          threads = parseReviewThreadsGhJson(
            await runCommand("gh", buildReviewThreadsArgs(owner, number), {
              timeoutMs,
            }),
          );
        } catch {
          throw new StatioForgeError("gh api graphql failed while reading review threads.");
        }
      }

      return parsePullRequestSummaryGhJson(prStdout, threads);
    },

    async reviewThreads(prNumber: number): Promise<ReviewThread[]> {
      if (!Number.isInteger(prNumber) || prNumber <= 0) {
        throw new StatioValidationError(
          `Pull request number must be a positive integer; received ${prNumber}.`,
        );
      }

      let repo: RepoInfo = { owner: "", defaultBranch: "" };
      try {
        repo = await resolveRepoInfo();
      } catch {
        return [];
      }

      const owner = splitOwner(repo.owner) ? repo.owner : "";
      if (!owner) {
        return [];
      }

      try {
        return parseReviewThreadsGhJson(
          await runCommand("gh", buildReviewThreadsArgs(owner, prNumber), {
            timeoutMs,
          }),
        );
      } catch {
        throw new StatioForgeError("gh api graphql failed while reading review threads.");
      }
    },
  };
}

function execText(
  command: string,
  args: readonly string[],
  options: StatioCommandOptions,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args as string[],
      {
        cwd: options.cwd,
        encoding: "utf-8",
        maxBuffer: EXEC_MAX_BUFFER,
        signal: AbortSignal.timeout(options.timeoutMs),
      },
      (err, stdout, stderr) => {
        if (err) {
          // execFile passes stderr as a separate callback argument; surface it
          // on the error so not-found detection can inspect gh's stderr text.
          if (typeof stderr === "string" && stderr) {
            (err as Error & { stderr?: string }).stderr = stderr;
          }
          reject(err);
          return;
        }
        resolve(typeof stdout === "string" ? stdout : "");
      },
    );
  });
}
