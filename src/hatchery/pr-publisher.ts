import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DispatchTrace } from "../observability/spawn-trace.js";
import { TesseraClient, TesseraClientError } from "../tessera/client.js";
import type { IntegrationCommit } from "./integration-publisher.js";
import { NEEDS_STEERING_LABEL, NEEDS_STEERING_LABEL_SPEC } from "../shared/steering.js";

export interface PullRequestRecord {
  readonly provider: "github";
  readonly repository: string;
  readonly number: number;
  readonly url: string;
  readonly headBranch: string;
  readonly baseBranch: string;
  readonly state: "open";
  readonly createdAt?: string;
  readonly observedAt: string;
}

type FailureReason = "base_unresolved" | "base_mismatch" | "head_mismatch" | "unauthorized" | "forbidden" |
  "network" | "timeout" | "publication_failed" | "review_failed" | "unsupported_origin" | "steering_label_failed";

export type PullRequestPublication =
  | { readonly status: "succeeded"; readonly pullRequest: PullRequestRecord }
  | { readonly status: "failed"; readonly failureReason: FailureReason; readonly diagnostic: string;
      readonly branch: string; readonly commit: IntegrationCommit; readonly existingPullRequest?: PullRequestRecord };

const diagnostics: Record<FailureReason, string> = {
  base_unresolved: "Could not resolve a GitHub base branch.",
  base_mismatch: "An open pull request targets a different base branch.",
  head_mismatch: "The open pull request head is not the reviewed commit.",
  unauthorized: "Steward authentication failed.",
  forbidden: "Steward permission to publish was denied.",
  network: "The publication service could not be reached.",
  timeout: "The Steward review or GitHub request timed out.",
  publication_failed: "GitHub pull request publication failed.",
  review_failed: "The Steward review did not approve publication.",
  unsupported_origin: "The pushed origin is not a supported GitHub repository.",
  steering_label_failed: `The pull request was opened but the ${NEEDS_STEERING_LABEL} label could not be applied.`,
};

export function pullRequestFailure(commit: IntegrationCommit, failureReason: FailureReason,
  existingPullRequest?: PullRequestRecord): PullRequestPublication {
  return { status: "failed", failureReason, diagnostic: diagnostics[failureReason],
    branch: commit.branch, commit, ...(existingPullRequest && { existingPullRequest }) };
}

class GitHubFailure extends Error {
  constructor(readonly reason: FailureReason) {
    super(diagnostics[reason]);
  }
}

function failureReason(error: unknown): FailureReason {
  if (error instanceof GitHubFailure) return error.reason;
  if (error instanceof TesseraClientError) {
    if (error.status === 401 || ["unconfigured", "unauthorized", "credential_invalid"].includes(error.code)) return "unauthorized";
    if (error.status === 403 || ["policy_denied", "repo_not_installed"].includes(error.code)) return "forbidden";
    if (error.code === "unreachable") return "network";
  }
  return "publication_failed";
}

export interface PullRequestMetadata {
  readonly title: string;
  readonly body: string;
  /** Labels applied right after the PR is created (GitHub's create call takes none). */
  readonly labels?: readonly string[];
}

/** `steering`: approved as written, but it gates a slice on a decision only a
 *  human can make, so the PR opens with {@link NEEDS_STEERING_LABEL} and the
 *  legate will not auto-merge it until the label is removed. */
export type Verification = "passed" | "unavailable" | "steering";

export const STEERING_QUESTION_LIMIT = 10;
const STEERING_QUESTION_CHARS = 600;

function clean(value: string): string {
  return value
    .replace(/(?:gh[pousr]_[\w-]+|github_pat_[\w-]+|sk-[\w-]+|AKIA[A-Z0-9]{16})/gi, "[redacted]")
    .replace(/(?:bearer|basic)\s+[\w+/=.-]+/gi, "[redacted]")
    .replace(/(?:password|token|secret|api[_-]?key)\s*[:=]\s*[^\s,;]+/gi, "[redacted]")
    .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/gi, "https://[redacted]@")
    .replace(/[\u0000-\u001f\u007f]/g, " ");
}

export const PR_TITLE_LIMIT = 70;
export const PR_BODY_LIMIT = 8192;

export function buildPullRequestMetadata(input: {
  commit: IntegrationCommit;
  backend: string;
  touchedPaths: readonly string[];
  verification?: Verification;
  /** The steward's `STEERING:` lines, for a `steering` verification. */
  steeringQuestions?: readonly string[];
}): PullRequestMetadata {
  const { commit, touchedPaths } = input;
  const steering = input.verification === "steering";
  const branch = clean(commit.branch);
  const title = `Review spawn ${clean(commit.spawnId)}`.slice(0, PR_TITLE_LIMIT);
  const header = [
    "## Summary",
    `- Spawn: ${clean(commit.spawnId)}`,
    `- Backend: ${clean(input.backend).slice(0, 80)}`,
    `- Branch: ${branch}`,
    `- Extraction: validated patch ${commit.patchSha256} affecting ${touchedPaths.length} path(s)`,
    "- Touched paths:",
  ].join("\n");
  const questions = (input.steeringQuestions ?? []).slice(0, STEERING_QUESTION_LIMIT).map((question) => {
    const text = clean(question).trim();
    return text.length > STEERING_QUESTION_CHARS ? text.slice(0, STEERING_QUESTION_CHARS - 1) + "…" : text;
  }).filter(Boolean);
  const steeringSection = steering
    ? [
      "",
      "",
      "## Steering required",
      `This change gates work on a decision that is still open. March will not auto-merge it while the \`${NEEDS_STEERING_LABEL}\` label is set.`,
      "Answer in the steward session: the steward applies the decision, removes the gate, and removes the label.",
      ...(questions.length ? questions.map((question) => `- ${question}`) : ["- The steward did not list the questions; see its session."]),
    ].join("\n")
    : "";
  const validation = input.verification === "passed" || steering ? "Steward verification passed." : "Verification results unavailable.";
  const footer = `${steeringSection}\n\n## Validation\n${validation}`;
  if (header.length + footer.length + 64 > PR_BODY_LIMIT) throw new GitHubFailure("publication_failed");
  const pathLines: string[] = [];
  let remaining = PR_BODY_LIMIT - header.length - footer.length - 64;
  for (const touchedPath of touchedPaths) {
    const sanitized = clean(touchedPath);
    const line = "\n  - " + JSON.stringify(sanitized.length > 1024 ? sanitized.slice(0, 1023) + "…" : sanitized);
    if (line.length > remaining) break;
    pathLines.push(line);
    remaining -= line.length;
  }
  if (pathLines.length < touchedPaths.length) {
    pathLines.push(`\n  - ${touchedPaths.length - pathLines.length} more path(s) omitted`);
  }
  return { title, body: header + pathLines.join("") + footer, ...(steering && { labels: [NEEDS_STEERING_LABEL] }) };
}

interface GitHubPull {
  number?: number;
  html_url?: string;
  state?: string;
  created_at?: string;
  head?: { ref?: string; sha?: string; repo?: { full_name?: string } | null };
  base?: { ref?: string; repo?: { full_name?: string } | null };
}

export async function openOrReusePullRequest(input: {
  repository: string;
  commit: IntegrationCommit;
  baseBranch?: string;
  metadata: PullRequestMetadata | (() => Promise<PullRequestMetadata | "review_failed" | "timeout">);
  homeDir?: string;
  sliceId?: string;
  dispatch?: DispatchTrace;
}, dependencies?: { token: (refresh: boolean) => Promise<string>; fetch: typeof fetch }): Promise<PullRequestPublication> {
  const { repository, commit } = input;
  const failed = (reason: FailureReason, record?: PullRequestRecord) => pullRequestFailure(commit, reason, record);
  if (!/^[a-z0-9-]+\/[a-z0-9_.-]+$/i.test(repository)) return failed("unsupported_origin");
  const root = `https://api.github.com/repos/${repository}`;
  const phase = <T>(name: string, operation: () => Promise<T>) =>
    input.dispatch ? input.dispatch.spanAsync(name, operation) : operation();
  let token: string;
  let refreshed = false;

  try {
    const getToken = dependencies?.token ?? (() => {
      let key: string;
      try {
        key = fs.readFileSync(path.join(input.homeDir ?? os.homedir(), ".march", "steward", "tessera-client-key"), "utf8").trim();
      } catch {
        throw new GitHubFailure("unauthorized");
      }
      if (!key) throw new GitHubFailure("unauthorized");
      const client = new TesseraClient({ clientKey: key, env: { MARCH_TESSERA_URL: process.env.MARCH_TESSERA_URL } });
      return async (refresh: boolean) => (await client.issueGitHubToken({
        identity: "app", access: "write", repo: repository, sliceId: input.sliceId, refresh,
      })).token;
    })();
    token = await getToken(false);

    // `probe` requests treat a redirect (for example a renamed branch) as
    // absence of the exact resource. Redirects are never followed, so the
    // token is never forwarded to another location.
    async function request(resource: string, body?: object, deadline?: AbortSignal, probe = false): Promise<{ value: unknown; hasNext?: boolean }> {
      const timeout = AbortSignal.timeout(10_000);
      const signal = deadline ? AbortSignal.any([timeout, deadline]) : timeout;
      let response: Response;
      try {
        response = await (dependencies?.fetch ?? fetch)(root + resource, {
          method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json",
            ...(body && { "content-type": "application/json" }) },
          body: body && JSON.stringify(body),
          redirect: probe ? "manual" : "error",
          signal,
        });
        if (response.ok) {
          return { value: await response.json(), hasNext: response.headers.get("link")?.includes('rel="next"') };
        }
        void response.body?.cancel().catch(() => {});
      } catch (error) {
        const timedOut = signal.aborted || (error instanceof Error && error.name === "TimeoutError");
        throw new GitHubFailure(timedOut ? "timeout" : "network");
      }
      if (response.status === 401 && !refreshed) {
        refreshed = true;
        token = await getToken(true);
        return request(resource, body, deadline, probe);
      }
      if (probe && response.status >= 300 && response.status < 400) return { value: undefined };
      if (response.status === 404 && !body) return { value: undefined };
      if (response.status === 401) throw new GitHubFailure("unauthorized");
      if (response.status === 403) throw new GitHubFailure("forbidden");
      if (response.status === 408 || response.status === 504) throw new GitHubFailure("timeout");
      throw new GitHubFailure(response.status >= 500 ? "network" : "publication_failed");
    }

    type Matched = { record: PullRequestRecord; headSha?: string };
    const match = (value: unknown): Matched | undefined => {
      const pr = value as GitHubPull | null;
      if (pr?.state !== "open" || pr.head?.ref !== commit.branch ||
        typeof pr.head.repo?.full_name !== "string" || pr.head.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
        typeof pr.base?.repo?.full_name !== "string" || pr.base.repo.full_name.toLowerCase() !== repository.toLowerCase() ||
        typeof pr.base.ref !== "string" || typeof pr.number !== "number" ||
        !Number.isSafeInteger(pr.number) || pr.number <= 0 ||
        typeof pr.html_url !== "string" ||
        pr.html_url.toLowerCase() !== `https://github.com/${repository}/pull/${pr.number}`.toLowerCase()) return;
      return { headSha: typeof pr.head.sha === "string" ? pr.head.sha.toLowerCase() : undefined, record: {
        provider: "github", repository, number: pr.number, url: pr.html_url, headBranch: commit.branch,
        baseBranch: pr.base.ref, state: "open", observedAt: new Date().toISOString(),
        ...(typeof pr.created_at === "string" && { createdAt: pr.created_at }),
      } };
    };
    const head = `${repository.split("/")[0]}:${commit.branch}`;
    const query = new URLSearchParams({ state: "open", head, per_page: "100" });
    const lookup = () => phase("steward.pr.lookup", async () => {
      const deadline = AbortSignal.timeout(15_000);
      const records: Matched[] = [];
      for (let page = 1; page <= 10; page++) {
        query.set("page", String(page));
        const result = await request(`/pulls?${query}`, undefined, deadline);
        if (!Array.isArray(result.value)) throw new GitHubFailure("publication_failed");
        for (const pr of result.value) {
          const record = match(pr);
          if (record) records.push(record);
        }
        if (!result.hasNext) return records;
      }
      throw new GitHubFailure("publication_failed");
    });
    const branchExists = async (branch: string) => {
      const result = (await request(`/branches/${encodeURIComponent(branch)}`, undefined, undefined, true)).value as
        { name?: unknown } | undefined;
      return result?.name === branch;
    };
    const existing = await lookup();
    let base = input.baseBranch;
    if (!base || !await branchExists(base)) {
      const repo = (await request("")).value as { default_branch?: unknown } | undefined;
      const defaultBranch = repo?.default_branch;
      base = typeof defaultBranch === "string" && defaultBranch && defaultBranch !== base &&
        await branchExists(defaultBranch) ? defaultBranch : undefined;
    }
    if (!base) return failed("base_unresolved", existing[0]?.record);
    // Success requires the PR head to be the exact reviewed commit; a branch
    // advanced by another writer must not be reported as this publication.
    const reviewedSha = commit.commitSha.toLowerCase();
    const compare = (records: Matched[]): PullRequestPublication | undefined => {
      const sameBase = records.filter(({ record }) => record.baseBranch === base);
      const current = sameBase.find(({ headSha }) => headSha === reviewedSha);
      if (current) return { status: "succeeded", pullRequest: current.record };
      if (sameBase.length) return failed("head_mismatch", sameBase[0].record);
      if (records.length) return failed("base_mismatch", records[0].record);
    };
    const reused = compare(existing);
    if (reused) return reused;

    const metadata = typeof input.metadata === "function" ? await input.metadata() : input.metadata;
    if (typeof metadata === "string") return failed(metadata);
    const { labels = [], ...pull } = metadata;
    // The steering label is the merge gate's hold, so a PR that should carry it
    // and does not is reported as a failed publication, never as a success.
    const labelled = async (result: PullRequestPublication): Promise<PullRequestPublication> => {
      if (result.status !== "succeeded" || labels.length === 0) return result;
      return phase("steward.pr.label", async () => {
        try {
          // Create the label with its colour on first use; it may already exist.
          await request("/labels", { name: NEEDS_STEERING_LABEL, ...NEEDS_STEERING_LABEL_SPEC }).catch(() => undefined);
          await request(`/issues/${result.pullRequest.number}/labels`, { labels });
          return result;
        } catch {
          return failed("steering_label_failed", result.pullRequest);
        }
      });
    };
    if (typeof input.metadata === "function") {
      const concurrent = compare(await lookup());
      if (concurrent) return labelled(concurrent);
    }
    let published: PullRequestPublication;
    try {
      published = await phase("steward.pr.create", async () => {
        const created = match((await request("/pulls", { ...pull, head, base })).value);
        const result = created && compare([created]);
        if (result) return result;
        throw new GitHubFailure("publication_failed");
      });
    } catch (error) {
      // GitHub arbitrates concurrent creates. Reconcile the same exact identity
      // after a conflict or a response that may have been lost after creation.
      const recovered = await lookup().then(compare).catch(() => undefined);
      published = recovered ?? failed(failureReason(error));
    }
    return labelled(published);
  } catch (error) {
    return failed(failureReason(error));
  }
}
