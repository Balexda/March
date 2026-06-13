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

export interface SpawnOutputSourceAdapter {
  readonly label: SpawnOutputSourceLabel;
  readOutput(spawnId: string): string | undefined;
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

export function captureSpawnOutput(
  input: CaptureSpawnOutputInput,
): SpawnOutputCaptureResult {
  const capturedAt = (input.now ?? (() => new Date()))().toISOString();

  if (!Number.isInteger(input.captureLimitChars) || input.captureLimitChars <= 0) {
    return failed(input, capturedAt, "capture-limit-invalid", "Capture limit must be a positive integer.");
  }

  if (input.terminalStatus !== "stopped") {
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

  let rawOutput: string | undefined;
  try {
    rawOutput = input.outputSource.readOutput(input.spawnId);
  } catch (err) {
    return failed(
      input,
      capturedAt,
      "output-unavailable",
      boundedDiagnostic(`Output source "${input.outputSource.label}" could not be read`, err),
    );
  }

  if (rawOutput === undefined) {
    return failed(
      input,
      capturedAt,
      "output-unavailable",
      `Output source "${input.outputSource.label}" returned no output for spawn ${input.spawnId}.`,
    );
  }

  if (rawOutput.trim().length === 0) {
    return failed(
      input,
      capturedAt,
      "output-empty",
      `Output source "${input.outputSource.label}" returned empty output for spawn ${input.spawnId}.`,
    );
  }

  const boundedRawJson = rawOutput.slice(-input.captureLimitChars);
  const truncated = rawOutput.length > input.captureLimitChars;
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
    diagnostic: truncated
      ? `Output exceeded capture limit of ${input.captureLimitChars} characters; retained trailing ${boundedRawJson.length} characters.`
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
    diagnostic: diagnosticTail(diagnostic),
    capturedAt,
  };
}

function boundedDiagnostic(prefix: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${prefix}: ${diagnosticTail(message)}`;
}

function diagnosticTail(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= DIAGNOSTIC_TAIL_CHARS) return trimmed;
  return `...${trimmed.slice(-DIAGNOSTIC_TAIL_CHARS)}`;
}
