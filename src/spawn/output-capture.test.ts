/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import {
  captureSpawnOutput,
  type CaptureSpawnOutputInput,
  type SpawnOutputSourceAdapter,
} from "./output-capture.js";

const capturedAt = new Date("2026-05-21T12:34:56.000Z");

function source(
  read: () => string | undefined,
  truncated = false,
): SpawnOutputSourceAdapter {
  return {
    label: "container",
    readOutput: () => {
      const rawJson = read();
      return rawJson === undefined ? undefined : { rawJson, truncated };
    },
  };
}

function input(
  overrides: Partial<CaptureSpawnOutputInput> = {},
): CaptureSpawnOutputInput {
  return {
    spawnId: "20260521-abc123",
    backend: "codex",
    terminalStatus: "stopped",
    exitCode: 0,
    worktreePath: "/worktrees/march/20260521-abc123",
    outputSource: source(() => '{"patch":"diff --git a/file.txt b/file.txt"}'),
    captureLimitChars: 1_000,
    now: () => capturedAt,
    ...overrides,
  };
}

describe("captureSpawnOutput", () => {
  it("captures stopped exit-code-0 output with spawn and backend identity", () => {
    const result = captureSpawnOutput(input());

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.envelope).toEqual({
      spawnId: "20260521-abc123",
      backend: "codex",
      source: "container",
      rawJson: '{"patch":"diff --git a/file.txt b/file.txt"}',
      truncated: false,
      capturedAt: "2026-05-21T12:34:56.000Z",
    });
    expect(result.diagnostic).toBeUndefined();
  });

  it("rejects running spawn state with a failed capture result", () => {
    const result = captureSpawnOutput(input({ terminalStatus: "running" }));

    expect(result).toMatchObject({
      ok: false,
      spawnId: "20260521-abc123",
      backend: "codex",
      source: "container",
      failureReason: "spawn-not-terminal",
      capturedAt: "2026-05-21T12:34:56.000Z",
    });
    expect(result).not.toHaveProperty("envelope");
  });

  it("rejects failed spawn state with a failed capture result", () => {
    // A non-zero exit transitions the SpawnRecord to status "failed"
    // (markSpawnRecordStopped), which is terminal but must not be captured.
    const result = captureSpawnOutput(
      input({ terminalStatus: "failed", exitCode: 2 }),
    );

    expect(result).toMatchObject({
      ok: false,
      failureReason: "spawn-exit-nonzero",
    });
    expect(result).not.toHaveProperty("envelope");
  });

  it("fails cleanly for empty and whitespace-only output", () => {
    for (const rawOutput of ["", " \n\t "]) {
      const result = captureSpawnOutput(
        input({ outputSource: source(() => rawOutput) }),
      );

      expect(result).toMatchObject({
        ok: false,
        failureReason: "output-empty",
      });
      expect(result).not.toHaveProperty("envelope");
    }
  });

  it("fails cleanly for missing and unreadable output sources", () => {
    const missing = captureSpawnOutput(
      input({ outputSource: source(() => undefined) }),
    );
    const unreadable = captureSpawnOutput(
      input({
        outputSource: source(() => {
          throw new Error("log file no longer exists");
        }),
      }),
    );

    expect(missing).toMatchObject({
      ok: false,
      failureReason: "output-unavailable",
    });
    expect(unreadable).toMatchObject({
      ok: false,
      failureReason: "output-unavailable",
    });
    expect(missing).not.toHaveProperty("envelope");
    expect(unreadable).not.toHaveProperty("envelope");
  });

  it("bounds over-limit output deterministically and reports truncation", () => {
    const result = captureSpawnOutput(
      input({
        captureLimitChars: 10,
        outputSource: source(() => "0123456789abcdef"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.envelope.rawJson).toBe("6789abcdef");
    expect(result.envelope.rawJson).toHaveLength(10);
    expect(result.envelope.truncated).toBe(true);
    expect(result.diagnostic).toContain("retained trailing 10 characters");
  });

  it("propagates source-side truncation even when within the capture limit", () => {
    const result = captureSpawnOutput(
      input({
        captureLimitChars: 1_000,
        outputSource: source(() => '{"patch":"diff"}', true),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.envelope.rawJson).toBe('{"patch":"diff"}');
    expect(result.envelope.truncated).toBe(true);
    expect(result.diagnostic).toContain("reported truncated output");
  });

  it("bounds unreadable-source diagnostics", () => {
    const result = captureSpawnOutput(
      input({
        outputSource: source(() => {
          throw new Error("x".repeat(2_000));
        }),
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected failed capture");
    expect(result.diagnostic.length).toBeLessThan(1_100);
    expect(result.diagnostic).not.toContain("x".repeat(1_500));
  });
});
