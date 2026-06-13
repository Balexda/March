import { createHash } from "node:crypto";
import type { Attributes } from "@opentelemetry/api";
import type {
  ExtractionBackend,
  ExtractionResult,
  SessionRecord,
} from "../brood/service/types.js";
import type { SessionRepository } from "../brood/service/repository.js";
import { startDispatchSpan } from "../observability/spawn-trace.js";

export type PrIntegrationFailureReason =
  | "missing-lifecycle"
  | "missing-extraction"
  | "extraction-failed"
  | "lifecycle-mismatch"
  | "malformed-extraction"
  | "noop-patch";

export interface PrIntegrationResult {
  readonly spawnId: string;
  readonly status: "succeeded" | "failed";
  readonly failureReason?: PrIntegrationFailureReason;
  readonly diagnostic?: string;
  readonly completedAt: string;
}

export interface EligiblePrExtraction {
  readonly spawnId: string;
  readonly backend: ExtractionBackend;
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
  readonly patchSha256: string;
  readonly extractedAt: string;
}

export interface PullRequestIntegrationInput {
  readonly spawnId: string;
  readonly backend: ExtractionBackend;
  /** Dispatch slice id when known; keeps integration spans in the slice trace. */
  readonly traceKey?: string;
}

export interface PrIntegrationRepository {
  readLifecycle(spawnId: string): SessionRecord | undefined;
  readExtractionResult(spawnId: string): ExtractionResult | undefined;
}

export interface PrIntegrationDeps {
  readonly repository: PrIntegrationRepository;
  readonly now?: () => Date;
  readonly nextStage?: (eligible: EligiblePrExtraction) => PrIntegrationResult;
}

export function prIntegrationRepositoryFromBrood(
  store: SessionRepository,
): PrIntegrationRepository {
  return {
    readLifecycle: (spawnId) => store.get(spawnId),
    readExtractionResult: (spawnId) => store.get(spawnId)?.extractionResult,
  };
}

export function integratePullRequest(
  input: PullRequestIntegrationInput,
  deps: PrIntegrationDeps,
): PrIntegrationResult {
  const now = deps.now ?? (() => new Date());
  const trace = startDispatchSpan({
    rootName: "pr.integration",
    traceKey: input.traceKey ?? input.spawnId,
    attributes: {
      "march.spawn_id": input.spawnId,
      "march.backend": input.backend,
    },
  });

  let failed = false;
  try {
    const result = trace.span("pr.integration.eligibility", (span) => {
      span.setAttributes(baseEligibilityAttributes(input));
      const lifecycle = deps.repository.readLifecycle(input.spawnId);
      if (!lifecycle) {
        const denied = refusal(input.spawnId, "missing-lifecycle", now);
        span.setError(denied.failureReason);
        return denied;
      }

      const extraction = deps.repository.readExtractionResult(input.spawnId);
      const eligible = evaluateExtractionEligibility(input, lifecycle, extraction);
      if (!eligible.ok) {
        const denied = refusal(
          input.spawnId,
          eligible.reason,
          now,
          eligible.diagnostic,
        );
        span.setAttributes({
          "march.pr_integration.eligible": false,
          "march.pr_integration.failure_reason": denied.failureReason ?? "unknown",
        });
        span.setError(denied.failureReason);
        return denied;
      }

      span.setAttributes({
        "march.pr_integration.eligible": true,
        "march.patch.files": eligible.extraction.touchedPaths.length,
      });
      return deps.nextStage
        ? deps.nextStage(eligible.extraction)
        : {
            spawnId: input.spawnId,
            status: "succeeded" as const,
            completedAt: now().toISOString(),
          };
    });

    failed = result.status === "failed";
    if (failed) trace.recordException(new Error(result.failureReason));
    return result;
  } finally {
    trace.end({ error: failed });
  }
}

type EligibilityDecision =
  | { readonly ok: true; readonly extraction: EligiblePrExtraction }
  | {
      readonly ok: false;
      readonly reason: PrIntegrationFailureReason;
      readonly diagnostic?: string;
    };

export function evaluateExtractionEligibility(
  input: PullRequestIntegrationInput,
  lifecycle: SessionRecord,
  extraction: ExtractionResult | undefined,
): EligibilityDecision {
  if (!extraction) {
    return {
      ok: false,
      reason: "missing-extraction",
      diagnostic: "No persisted extraction result is available for this spawn.",
    };
  }

  if (extraction.status === "failed") {
    return {
      ok: false,
      reason: "extraction-failed",
      diagnostic: boundedDiagnostic(extraction.diagnostic ?? extraction.failureReason),
    };
  }

  if (
    lifecycle.id !== input.spawnId ||
    extraction.spawnId !== input.spawnId ||
    extraction.patch.spawnId !== input.spawnId ||
    lifecycle.backend !== input.backend ||
    extraction.backend !== input.backend ||
    extraction.patch.backend !== input.backend
  ) {
    return {
      ok: false,
      reason: "lifecycle-mismatch",
      diagnostic: "Extraction metadata does not match the recorded spawn lifecycle.",
    };
  }

  const patch = extraction.patch;
  if (!patch.sha256 || patch.touchedPaths.length === 0) {
    return {
      ok: false,
      reason: "malformed-extraction",
      diagnostic: "Successful extraction is missing validated patch metadata.",
    };
  }

  if (normalizedPatchIsNoop(patch.patchText)) {
    return {
      ok: false,
      reason: "noop-patch",
      diagnostic: "Validated patch is empty or contains no reviewable file changes.",
    };
  }

  if (!digestMatches(patch.patchText, patch.sha256) || !touchedPathsMatch(patch)) {
    return {
      ok: false,
      reason: "malformed-extraction",
      diagnostic: "Successful extraction patch metadata does not match the patch text.",
    };
  }

  return {
    ok: true,
    extraction: {
      spawnId: input.spawnId,
      backend: input.backend,
      patchText: patch.patchText,
      touchedPaths: [...patch.touchedPaths],
      patchSha256: patch.sha256,
      extractedAt: extraction.extractedAt,
    },
  };
}

function digestMatches(patchText: string, expected: string): boolean {
  const actual = createHash("sha256").update(patchText).digest("hex");
  const normalized = expected.startsWith("sha256:")
    ? expected.slice("sha256:".length)
    : expected;
  return normalized === actual;
}

function touchedPathsMatch(patch: {
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
}): boolean {
  const fromPatch = new Set<string>();
  const headerRe = /^diff --git a\/(.+?) b\/(.+)$/gm;
  let match: RegExpExecArray | null;
  while ((match = headerRe.exec(patch.patchText)) !== null) {
    fromPatch.add(match[2]);
  }
  const expected = new Set(patch.touchedPaths);
  if (fromPatch.size !== expected.size) return false;
  for (const path of fromPatch) {
    if (!expected.has(path)) return false;
  }
  return true;
}

function refusal(
  spawnId: string,
  reason: PrIntegrationFailureReason,
  now: () => Date,
  diagnostic?: string,
): PrIntegrationResult {
  return {
    spawnId,
    status: "failed",
    failureReason: reason,
    diagnostic: boundedDiagnostic(diagnostic ?? reason),
    completedAt: now().toISOString(),
  };
}

function normalizedPatchIsNoop(patchText: string): boolean {
  const normalized = patchText.replace(/\r\n/g, "\n").trim();
  if (!normalized) return true;
  if (!/^diff --git /m.test(normalized)) return true;
  return !normalized.split("\n").some((line) => {
    if (line.startsWith("+++") || line.startsWith("---")) return false;
    return (
      line.startsWith("+") ||
      line.startsWith("-") ||
      /^new file mode |^deleted file mode |^rename (from|to) /.test(line)
    );
  });
}

function boundedDiagnostic(message: string): string {
  return message.replace(/[A-Za-z0-9._%+-]+:[^\s@]+@[^\s]+/g, "[redacted]").slice(0, 512);
}

function baseEligibilityAttributes(input: PullRequestIntegrationInput): Attributes {
  return {
    "march.spawn_id": input.spawnId,
    "march.backend": input.backend,
    "march.pr_integration.stage": "eligibility",
  };
}
