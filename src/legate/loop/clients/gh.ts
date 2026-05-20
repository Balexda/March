import { execText } from "./exec.js";
import { prNumber } from "../pure/session.js";

/**
 * GitHub client: PR state, CI checks, and review threads via `gh`. The repo path
 * is passed explicitly (no global meta). `checksSummary`/`failedChecks` are pure
 * over the statusCheckRollup and are exported for unit testing.
 */

export function repoOwner(state: any, repoPath: string | undefined): string | null {
  const owner = state?.repo?.owner_with_name;
  if (typeof owner === "string" && owner.length > 0) return owner;
  if (typeof repoPath !== "string" || repoPath.length === 0) return null;
  try {
    const out = execText("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], {
      cwd: repoPath,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

interface GhPrArgs {
  skipped?: boolean;
  reason?: string;
  args?: string[];
  options?: { cwd?: string };
  owner?: string | null;
  number?: string | null;
}

export function ghPrArgs(slice: any, state: any, fields: string, repoPath: string | undefined): GhPrArgs {
  const number = prNumber(slice);
  if (!number) return { skipped: true, reason: "missing_pr_number" };
  const args = ["pr", "view", number, "--json", fields];
  const owner = repoOwner(state, repoPath);
  if (typeof owner === "string" && owner.length > 0) args.push("-R", owner);
  const options: { cwd?: string } = {};
  if (!owner && typeof repoPath === "string" && repoPath.length > 0) options.cwd = repoPath;
  return { args, options, owner, number };
}

export function queryPr(slice: any, state: any, repoPath: string | undefined): any {
  const request = ghPrArgs(slice, state, "number,url,state", repoPath);
  if (request.skipped) return request;
  return JSON.parse(execText("gh", request.args!, request.options));
}

/** Pure: roll up CI check conclusions to NONE/FAIL/PENDING/PASS. */
export function checksSummary(statusCheckRollup: any): "NONE" | "FAIL" | "PENDING" | "PASS" {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  if (checks.length === 0) return "NONE";
  if (checks.some((c: any) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(c.conclusion)))
    return "FAIL";
  if (checks.some((c: any) => ["IN_PROGRESS", "QUEUED", "PENDING"].includes(c.status))) return "PENDING";
  return "PASS";
}

/** Pure: the failed checks with name + details url. */
export function failedChecks(statusCheckRollup: any): { name: string; url: string | null }[] {
  const checks = Array.isArray(statusCheckRollup) ? statusCheckRollup : [];
  return checks
    .filter((c: any) => ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "CANCELLED"].includes(c.conclusion))
    .map((c: any) => ({ name: c.name || c.context || "unknown", url: c.detailsUrl || c.targetUrl || null }));
}

export function queryReviewThreads(owner: string | null, prNumberValue: any): any[] {
  if (!owner) return [];
  const [repoOwnerName, repoName] = owner.split("/");
  if (!repoOwnerName || !repoName) return [];
  const out = execText("gh", [
    "api",
    "graphql",
    "-F",
    `owner=${repoOwnerName}`,
    "-F",
    `name=${repoName}`,
    "-F",
    `pr=${prNumberValue}`,
    "-f",
    `query=query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      reviewThreads(first: 100) {
        nodes {
          isResolved
          comments(first: 50) {
            nodes { databaseId body path line author { login } createdAt }
          }
        }
      }
    }
  }
}`,
  ]);
  const parsed = JSON.parse(out);
  const nodes = parsed?.data?.repository?.pullRequest?.reviewThreads?.nodes || [];
  return nodes
    .filter((thread: any) => thread && thread.isResolved === false)
    .map((thread: any) => {
      const comments = Array.isArray(thread.comments?.nodes)
        ? [...thread.comments.nodes].sort((a: any, b: any) =>
            String(a.createdAt).localeCompare(String(b.createdAt)),
          )
        : [];
      const first = comments[0] || {};
      const last = comments[comments.length - 1] || first;
      return {
        id: first.databaseId,
        path: first.path,
        line: first.line,
        author: first.author?.login,
        body_preview: String(first.body || "").slice(0, 140),
        last_author: last.author?.login,
        last_comment_at: last.createdAt,
        comment_count: comments.length,
      };
    });
}

export function queryPrForBabysit(slice: any, state: any, repoPath: string | undefined): any {
  const request = ghPrArgs(
    slice,
    state,
    "number,url,state,mergeable,reviewDecision,statusCheckRollup,headRefName,title,author",
    repoPath,
  );
  if (request.skipped) return request;
  const summary = JSON.parse(execText("gh", request.args!, request.options));
  const threads = queryReviewThreads(request.owner || repoOwner(state, repoPath), summary.number);
  const prAuthor = summary.author?.login || "";
  const annotated = threads.map((thread: any) => ({ ...thread, needs_response: thread.last_author !== prAuthor }));
  return {
    number: summary.number,
    url: summary.url,
    state: summary.state,
    mergeable: summary.mergeable,
    head_branch: summary.headRefName,
    title: summary.title,
    review_decision: summary.reviewDecision,
    checks: checksSummary(summary.statusCheckRollup),
    failed_checks: failedChecks(summary.statusCheckRollup),
    unresolved_threads: annotated,
    thread_count: annotated.length,
    needs_response_count: annotated.filter((t: any) => t.needs_response).length,
  };
}
