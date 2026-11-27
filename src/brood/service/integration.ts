import { INTEGRATION_FAILURE_REASONS } from "./types.js";
import type {
  IntegrationApplication,
  IntegrationAttemptState,
  IntegrationCommitRecord,
  IntegrationFailureReason,
  IntegrationPullRequestRecord,
  PrIntegrationResult,
  RegisterIntegrationAttempt,
} from "./types.js";

export const INTEGRATION_DIAGNOSTIC_LIMIT = 500;

export function redactIntegrationDiagnostic(value: string): string {
  return value
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/gi, "[redacted]")
    .replace(/(?:gh[pousr]_[\w-]+|github_pat_[\w-]+|sk-[\w-]+|AKIA[A-Z0-9]{16})/gi, "[redacted]")
    .replace(/(?:bearer|basic)\s+[\w+/=.-]+/gi, "[redacted]")
    .replace(/(?:password|token|secret|api[_-]?key)["']?\s*[:=]\s*(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi, "[redacted]")
    .replace(/https?:\/\/[^\s/@]+@/gi, "https://[redacted]@")
    .slice(0, INTEGRATION_DIAGNOSTIC_LIMIT);
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function timestamp(value: unknown): value is string {
  return text(value) && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
}

export function parseIntegrationAttempt(value: unknown): RegisterIntegrationAttempt | undefined {
  const { attemptId, spawnId, stewardDeadline } = object(value);
  if (!text(attemptId) || !text(spawnId) || !timestamp(stewardDeadline)) return;
  return { attemptId, spawnId, stewardDeadline };
}

function parseApplication(value: unknown): IntegrationApplication | undefined {
  const { spawnId, status, touchedPaths, appliedAt, diagnostic } = object(value);
  if (!text(spawnId) || (status !== "applied" && status !== "failed") ||
      !Array.isArray(touchedPaths) || !touchedPaths.every(text) ||
      (status === "applied" && touchedPaths.length === 0) ||
      (appliedAt !== undefined && !timestamp(appliedAt)) ||
      (diagnostic !== undefined && !text(diagnostic))) return;
  return {
    spawnId, status, touchedPaths,
    ...(appliedAt && { appliedAt }),
    ...(diagnostic && { diagnostic: redactIntegrationDiagnostic(diagnostic) }),
  };
}

function parseCommit(value: unknown): IntegrationCommitRecord | undefined {
  const { spawnId, branch, commitSha, patchSha256, committedAt } = object(value);
  if (!text(spawnId) || !text(branch) || !text(commitSha) || !text(patchSha256) ||
      !timestamp(committedAt)) return;
  return { spawnId, branch, commitSha, patchSha256, committedAt };
}

function parsePullRequest(value: unknown): IntegrationPullRequestRecord | undefined {
  const { provider, repository, number, url, headBranch, baseBranch, state, createdAt, observedAt } = object(value);
  if (provider !== "github" || !text(repository) || typeof number !== "number" ||
      !Number.isSafeInteger(number) || number < 1 || !text(url) || !text(headBranch) ||
      !text(baseBranch) || (state !== "open" && state !== "closed" && state !== "merged") ||
      (createdAt !== undefined && !timestamp(createdAt)) || !timestamp(observedAt)) return;
  return { provider, repository, number, url, headBranch, baseBranch, state, observedAt, ...(createdAt && { createdAt }) };
}

export function parseIntegrationOutcome(value: unknown): PrIntegrationResult | undefined {
  const record = object(value);
  const { spawnId, completedAt, status, failureReason, diagnostic, stewardSessionId, worktreePath, artifactsDir } = record;
  if ((!text(spawnId) && spawnId !== null) || !timestamp(completedAt) ||
      (stewardSessionId !== undefined && !text(stewardSessionId)) ||
      (worktreePath !== undefined && !text(worktreePath)) ||
      (artifactsDir !== undefined && !text(artifactsDir))) return;
  const application = parseApplication(record.application);
  const commit = parseCommit(record.commit);
  const pullRequest = parsePullRequest(record.pullRequest);
  if ((record.application !== undefined && application?.spawnId !== spawnId) ||
      (record.commit !== undefined && commit?.spawnId !== spawnId) ||
      (record.pullRequest !== undefined && !pullRequest) ||
      (commit && pullRequest && commit.branch !== pullRequest.headBranch)) return;
  const artifacts = {
    spawnId, completedAt,
    ...(stewardSessionId && { stewardSessionId }),
    ...(worktreePath && { worktreePath }),
    ...(artifactsDir && { artifactsDir }),
  };
  if (status === "succeeded" && spawnId !== null && application?.status === "applied" && commit && pullRequest) {
    return { ...artifacts, spawnId, status, application, commit, pullRequest };
  }
  if (status === "failed" && text(diagnostic) &&
      INTEGRATION_FAILURE_REASONS.includes(failureReason as IntegrationFailureReason)) {
    return {
      ...artifacts, status, failureReason: failureReason as IntegrationFailureReason,
      diagnostic: redactIntegrationDiagnostic(diagnostic),
      ...(application && { application }),
      ...(commit && { commit }),
      ...(pullRequest && { pullRequest }),
    };
  }
}

export function parseIntegrationAttemptState(value: unknown): IntegrationAttemptState | undefined {
  const { attemptId, spawnId, stewardDeadline, fenced, outcome } = object(value);
  if (!text(attemptId) || typeof fenced !== "boolean") return;
  if (spawnId === null && stewardDeadline === null && outcome === null) {
    return { attemptId, spawnId, stewardDeadline, fenced, outcome };
  }
  if (!text(spawnId) || !timestamp(stewardDeadline)) return;
  const parsed = outcome === null ? null : parseIntegrationOutcome(outcome);
  if (parsed === undefined || (parsed && parsed.spawnId !== spawnId)) return;
  return { attemptId, spawnId, stewardDeadline, fenced, outcome: parsed };
}
