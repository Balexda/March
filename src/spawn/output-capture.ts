// Spawn Output Extraction — Feature 5, User Story 1 / Slice 1 (the capture
// boundary). Spec: specs/2026-05-21-005-spawn-output-extraction/.
//
// SCOPE / WIRING: this module is intentionally a pure, service-free boundary
// and is NOT yet wired into the live dispatch path. Production patch capture
// today is the deterministic git-commit harness, NOT this module: the spawn
// container scaffolds its own git and emits a `__MARCH_PATCH_B64__` sentinel
// (`composeGitScaffoldedEntrypoint`, src/spawn/backends.ts), which Hatchery
// reads + applies via `extractPatchFromSpawnOutput` /
// `applyPatchToManagerWorktree` (src/hatchery/spawn-handoff.ts). That sentinel
// path exists *because* scraping the agent's JSON stdout for patch bytes
// truncated large patches ("corrupt patch" bug); patch bytes must keep coming
// from the git diff, not from re-parsed JSON.
//
// ROLE (settled on PR #344): the sentinel harness recovers *only* the patch
// bytes — every other piece of backend output (summary, metadata, diagnostics,
// failure context) is dropped on the floor today. And it works only because the
// spawn is not yet truly locked down: the container is trusted to scaffold its
// own git and emit the sentinel. Both of those are the gap this feature fills.
//
// So the division of labor is: this envelope is the durable capture of the
// backend's JSON output — the context the sentinel path loses — and it becomes
// the patch-carrying path too once spawns are sandboxed and can no longer
// self-scaffold git. The later slices add an `OutputSource` adapter for
// `"container"` that wraps the existing container-log read, then layer
// validation (US2), a persisted backend-neutral result (US3), and the Steward
// handoff (US4) on top. Until the sandbox lockdown lands, the sentinel diff
// remains the source of truth for the patch and this envelope carries the
// surrounding context alongside it.
export type SpawnOutputSourceLabel =
  | "container"
  | "castra-session"
  | "hatchery-job";

export interface SpawnOutputEnvelope {
  readonly spawnId: string;
  readonly backend: string;
  readonly source: SpawnOutputSourceLabel;
  readonly rawJson: string;
  readonly truncated: boolean;
  readonly capturedAt: string;
}

/**
 * Bounded output returned by a source adapter. Per the extraction contract,
 * a real container / Castra / Hatchery source enforces `captureLimitChars`
 * itself to avoid materializing huge logs, so it reports whether it had to
 * truncate via `truncated` rather than handing back unbounded output.
 */
export interface SpawnOutputReadResult {
  readonly rawJson: string;
  readonly truncated: boolean;
}

export interface SpawnOutputSourceAdapter {
  readonly label: SpawnOutputSourceLabel;
  readOutput(spawnId: string): SpawnOutputReadResult | undefined;
}

export interface CaptureSpawnOutputInput {
  readonly spawnId: string;
  readonly backend: string;
  readonly terminalStatus: string;
  readonly exitCode?: number;
  readonly worktreePath: string;
  readonly outputSource: SpawnOutputSourceAdapter;
  readonly captureLimitChars: number;
  readonly now?: () => Date;
}

export type SpawnOutputCaptureFailureReason =
  | "spawn-not-terminal"
  | "spawn-exit-nonzero"
  | "output-unavailable"
  | "output-empty"
  | "capture-limit-invalid";

export interface SpawnOutputCaptureSucceeded {
  readonly ok: true;
  readonly envelope: SpawnOutputEnvelope;
  readonly diagnostic?: string;
}

export interface SpawnOutputCaptureFailed {
  readonly ok: false;
  readonly spawnId: string;
  readonly backend: string;
  readonly source: SpawnOutputSourceLabel;
  readonly failureReason: SpawnOutputCaptureFailureReason;
  readonly diagnostic: string;
  readonly capturedAt: string;
}

export type SpawnOutputCaptureResult =
  | SpawnOutputCaptureSucceeded
  | SpawnOutputCaptureFailed;

const DIAGNOSTIC_TAIL_CHARS = 1_024;

/** Spawn statuses the wait stage resolves to (data-model: `SpawnStatus`). */
const TERMINAL_STATUSES = new Set(["stopped", "failed"]);

export function captureSpawnOutput(
  input: CaptureSpawnOutputInput,
): SpawnOutputCaptureResult {
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();

  if (!Number.isInteger(input.captureLimitChars) || input.captureLimitChars <= 0) {
    return failed(input, capturedAt, "capture-limit-invalid", "Capture limit must be a positive integer.");
  }

  // A spawn is terminal once the wait stage has resolved it. Per the data
  // model (`markSpawnRecordStopped`), a non-zero exit transitions the record
  // to "failed", so both "stopped" and "failed" are terminal; success is then
  // gated strictly on the exit code below.
  if (!TERMINAL_STATUSES.has(input.terminalStatus)) {
    return failed(
      input,
      capturedAt,
      "spawn-not-terminal",
      `Spawn ${input.spawnId} is not ready for output capture: status is "${input.terminalStatus}".`,
    );
  }

  if (input.exitCode !== 0) {
    return failed(
      input,
      capturedAt,
      "spawn-exit-nonzero",
      `Spawn ${input.spawnId} is not ready for output capture: exit code is ${String(input.exitCode)}.`,
    );
  }

  let read: SpawnOutputReadResult | undefined;
  try {
    read = input.outputSource.readOutput(input.spawnId);
  } catch (err) {
    return failed(
      input,
      capturedAt,
      "output-unavailable",
      boundedDiagnostic(`Output source "${input.outputSource.label}" could not be read`, err),
    );
  }

  if (read === undefined) {
    return failed(
      input,
      capturedAt,
      "output-unavailable",
      `Output source "${input.outputSource.label}" returned no output for spawn ${input.spawnId}.`,
    );
  }

  const rawOutput = read.rawJson;
  if (rawOutput.trim().length === 0) {
    return failed(
      input,
      capturedAt,
      "output-empty",
      `Output source "${input.outputSource.label}" returned empty output for spawn ${input.spawnId}.`,
    );
  }

  const boundedRawJson = rawOutput.slice(-input.captureLimitChars);
  const localTruncated = rawOutput.length > input.captureLimitChars;
  // Truncation is reported when the source already bounded the output OR when
  // we bound it locally here, so source-side truncation is never mislabeled.
  const truncated = read.truncated || localTruncated;
  return {
    ok: true,
    envelope: {
      spawnId: input.spawnId,
      backend: input.backend,
      source: input.outputSource.label,
      rawJson: boundedRawJson,
      truncated,
      capturedAt,
    },
    diagnostic: localTruncated
      ? `Output exceeded capture limit of ${input.captureLimitChars} characters; retained trailing ${boundedRawJson.length} characters.`
      : read.truncated
        ? `Output source "${input.outputSource.label}" reported truncated output before the capture limit was reached.`
        : undefined,
  };
}

function failed(
  input: CaptureSpawnOutputInput,
  capturedAt: string,
  failureReason: SpawnOutputCaptureFailureReason,
  diagnostic: string,
): SpawnOutputCaptureFailed {
  return {
    ok: false,
    spawnId: input.spawnId,
    backend: input.backend,
    source: input.outputSource.label,
    failureReason,
    // Callers pass an already-bounded diagnostic (static strings here are
    // short; untrusted content is bounded via `boundedDiagnostic`), so we do
    // not re-truncate and risk chopping off the context prefix.
    diagnostic,
    capturedAt,
  };
}

function boundedDiagnostic(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  // Bound only the untrusted message tail so the context prefix is preserved.
  return `${prefix}: ${diagnosticTail(message)}`;
}

function diagnosticTail(text: string): string {
  // Mirrors `stderrTail` in container-launch.ts / snapshot-build.ts.
  const trimmed = text.trimEnd();
  if (trimmed.length <= DIAGNOSTIC_TAIL_CHARS) return trimmed;
  return "…" + trimmed.slice(-DIAGNOSTIC_TAIL_CHARS);
}
