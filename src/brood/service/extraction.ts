import type { ExtractionBackend, ExtractionResult, SpawnPatch } from "./types.js";

const EXTRACTION_BACKENDS: readonly ExtractionBackend[] = [
  "claude-code",
  "codex",
];

/**
 * Upper bound (1 MiB) on a persisted validated patch. Bounds the `patchText`
 * payload accepted over the Brood HTTP surface so a client cannot push
 * unbounded spawn output into the registry (DoS / oversized-row guard).
 */
export const MAX_PATCH_TEXT_BYTES = 1_048_576;

function isBackend(value: unknown): value is ExtractionBackend {
  return (
    typeof value === "string" &&
    EXTRACTION_BACKENDS.includes(value as ExtractionBackend)
  );
}

/** Runtime type guard for an untrusted (HTTP body or persisted) SpawnPatch. */
export function isSpawnPatch(value: unknown): value is SpawnPatch {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.spawnId === "string" &&
    isBackend(v.backend) &&
    typeof v.patchText === "string" &&
    Buffer.byteLength(v.patchText, "utf8") <= MAX_PATCH_TEXT_BYTES &&
    typeof v.sha256 === "string" &&
    Array.isArray(v.touchedPaths) &&
    v.touchedPaths.every((entry) => typeof entry === "string")
  );
}

/**
 * Validate an untrusted `ExtractionResult` (an HTTP request body or a row of
 * persisted JSON). Returns the value typed when it conforms, else `undefined`
 * so callers treat malformed state as "no extraction result" — never trusting
 * an arbitrary shape and never throwing on a bad/oversized payload.
 */
export function parseExtractionResult(
  value: unknown,
): ExtractionResult | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.spawnId !== "string" || !isBackend(v.backend)) return undefined;
  if (typeof v.extractedAt !== "string") return undefined;
  if (v.diagnostic !== undefined && typeof v.diagnostic !== "string") {
    return undefined;
  }
  const diagnostic =
    typeof v.diagnostic === "string" ? { diagnostic: v.diagnostic } : {};

  if (v.status === "failed") {
    if (typeof v.failureReason !== "string") return undefined;
    return {
      spawnId: v.spawnId,
      backend: v.backend,
      status: "failed",
      failureReason: v.failureReason,
      ...diagnostic,
      extractedAt: v.extractedAt,
    };
  }
  if (v.status === "succeeded") {
    if (!isSpawnPatch(v.patch)) return undefined;
    return {
      spawnId: v.spawnId,
      backend: v.backend,
      status: "succeeded",
      patch: v.patch,
      ...diagnostic,
      extractedAt: v.extractedAt,
    };
  }
  return undefined;
}
