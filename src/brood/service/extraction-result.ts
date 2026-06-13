import type { SessionRepository } from "./repository.js";

export const MAX_EXTRACTION_DIAGNOSTIC_CHARS = 2000;

export interface SpawnPatch {
  readonly spawnId: string;
  readonly backend: string;
  readonly patchText: string;
  readonly touchedPaths: readonly string[];
  readonly sha256: string;
}

export type ExtractionResult =
  | {
      readonly status: "succeeded";
      readonly spawnId: string;
      readonly backend: string;
      readonly patch: SpawnPatch;
      readonly extractedAt: string;
    }
  | {
      readonly status: "failed";
      readonly spawnId: string;
      readonly backend: string;
      readonly failureReason: string;
      readonly diagnostic: string;
      readonly extractedAt: string;
    };

export type TerminalValidationOutcome =
  | {
      readonly status: "accepted";
      readonly patchText: string;
      readonly touchedPaths: readonly string[];
      readonly sha256: string;
    }
  | {
      readonly status: "failed";
      readonly failureReason: string;
      readonly diagnostic: string;
    };

export interface PersistExtractionResultInput {
  readonly spawnId: string;
  readonly backend: string;
  readonly outcome: TerminalValidationOutcome;
  readonly extractedAt?: string;
}

export type ExtractionPersistenceResult =
  | {
      readonly ok: true;
      readonly result: ExtractionResult;
    }
  | {
      readonly ok: false;
      readonly result: ExtractionResult;
    };

export function boundExtractionDiagnostic(diagnostic: string): string {
  if (diagnostic.length <= MAX_EXTRACTION_DIAGNOSTIC_CHARS) {
    return diagnostic;
  }
  return diagnostic.slice(0, MAX_EXTRACTION_DIAGNOSTIC_CHARS);
}

export function extractionResultFromValidation(
  input: PersistExtractionResultInput,
): ExtractionResult {
  const extractedAt = input.extractedAt ?? new Date().toISOString();
  if (input.outcome.status === "accepted") {
    return {
      status: "succeeded",
      spawnId: input.spawnId,
      backend: input.backend,
      patch: {
        spawnId: input.spawnId,
        backend: input.backend,
        patchText: input.outcome.patchText,
        touchedPaths: [...input.outcome.touchedPaths],
        sha256: input.outcome.sha256,
      },
      extractedAt,
    };
  }

  return {
    status: "failed",
    spawnId: input.spawnId,
    backend: input.backend,
    failureReason: input.outcome.failureReason,
    diagnostic: boundExtractionDiagnostic(input.outcome.diagnostic),
    extractedAt,
  };
}

export function persistExtractionResult(
  repository: SessionRepository,
  input: PersistExtractionResultInput,
): ExtractionPersistenceResult {
  const result = extractionResultFromValidation(input);
  const existing = repository.get(input.spawnId);
  if (!existing || existing.kind !== "spawn") {
    return {
      ok: false,
      result: {
        status: "failed",
        spawnId: input.spawnId,
        backend: input.backend,
        failureReason: existing ? "not-spawn-session" : "spawn-session-missing",
        diagnostic: existing
          ? `Brood session "${input.spawnId}" is not a spawn session.`
          : `Brood has no spawn session "${input.spawnId}" for extraction persistence.`,
        extractedAt: result.extractedAt,
      },
    };
  }

  const updated = repository.recordExtractionResult(input.spawnId, result);
  if (!updated) {
    return {
      ok: false,
      result: {
        status: "failed",
        spawnId: input.spawnId,
        backend: input.backend,
        failureReason: "spawn-session-stale",
        diagnostic: `Brood spawn session "${input.spawnId}" disappeared during extraction persistence.`,
        extractedAt: result.extractedAt,
      },
    };
  }

  return { ok: true, result };
}
