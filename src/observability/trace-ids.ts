import { createHash, randomBytes } from "node:crypto";

/**
 * Telemetry identity helpers. Pure (no OpenTelemetry dependency) so the exact
 * same derivation runs in the orchestrator and in the in-container emitter.
 *
 * A "dispatch" is one unit of work the Legate loop hands off — e.g.
 * `forge <slug> <slice-id>` (the `dispatchSliceId`). Each dispatch is its own
 * trace: the trace id is hashed deterministically from the dispatch key so that
 * spans emitted by separate, short-lived processes (the loop, the spawn
 * process, the in-container backend) land in one trace with no shared in-memory
 * context to propagate.
 */

/** 16-byte (32 hex) W3C trace id derived deterministically from a dispatch key. */
export function traceIdForDispatch(key: string): string {
  return createHash("sha256").update("march.trace:" + key).digest("hex").slice(0, 32);
}

/**
 * 8-byte (16 hex) span id derived deterministically from a dispatch key. Used
 * as the (virtual) parent of the per-process root span so that a later
 * `legate.dispatch` span — emitted from a different process — can claim this
 * exact id and have the spawn-side spans nest beneath it.
 */
export function spanIdForDispatch(key: string): string {
  return createHash("sha256").update("march.span:" + key).digest("hex").slice(0, 16);
}

/** Fresh random 8-byte (16 hex) span id. */
export function randomSpanId(): string {
  return randomBytes(8).toString("hex");
}

/** Build a W3C `traceparent` header value (version 00, sampled). */
export function buildTraceparent(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}
