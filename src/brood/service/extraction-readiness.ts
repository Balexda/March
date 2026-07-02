import type { ExtractionReadiness, SessionRecord } from "./types.js";

/**
 * Derive the stable lifecycle read contract for extraction completion and
 * PR-integration readiness from a Brood session row.
 */
export function extractionReadiness(
  session: Pick<SessionRecord, "id" | "extractionResult">,
): ExtractionReadiness {
  const result = session.extractionResult;
  if (!result) {
    return {
      spawnId: session.id,
      status: "missing",
      prReady: false,
    };
  }
  if (result.status === "failed") {
    return {
      spawnId: result.spawnId,
      status: "failed",
      prReady: false,
      result,
    };
  }
  return {
    spawnId: result.spawnId,
    status: "succeeded",
    prReady: true,
    result,
  };
}
