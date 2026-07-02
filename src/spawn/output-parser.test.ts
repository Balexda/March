/**
 * @l0 @deterministic @ci
 */
import { describe, expect, it } from "vitest";
import type { SpawnOutputEnvelope } from "./output-capture.js";
import { parseBackendEnvelope } from "./output-parser.js";

function envelope(overrides: Partial<SpawnOutputEnvelope>): SpawnOutputEnvelope {
  return {
    spawnId: "20260521-abc123",
    backend: "codex",
    source: "container",
    rawJson: JSON.stringify({
      patchText: "diff --git a/file.txt b/file.txt\n",
    }),
    truncated: false,
    capturedAt: "2026-05-21T12:34:56.000Z",
    ...overrides,
  };
}

describe("parseBackendEnvelope", () => {
  it("routes Claude Code output to the Claude adapter and returns one candidate patch", () => {
    const result = parseBackendEnvelope(
      envelope({
        backend: "claude-code",
        rawJson: JSON.stringify({
          type: "result",
          result: {
            patchText: "diff --git a/claude.txt b/claude.txt\n",
            summary: "updated the Claude fixture",
          },
        }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.candidate).toEqual({
      spawnId: "20260521-abc123",
      backend: "claude-code",
      patchText: "diff --git a/claude.txt b/claude.txt\n",
      summary: "updated the Claude fixture",
      parser: "claude-code",
    });
  });

  it("routes Codex JSONL output to the Codex adapter and returns one candidate patch", () => {
    const result = parseBackendEnvelope(
      envelope({
        backend: "codex",
        rawJson: [
          JSON.stringify({ type: "session.created", id: "session-1" }),
          JSON.stringify({
            type: "turn.completed",
            output: {
              patch: "diff --git a/codex.txt b/codex.txt\n",
              summary: "updated the Codex fixture",
            },
          }),
        ].join("\n"),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.candidate).toMatchObject({
      spawnId: "20260521-abc123",
      backend: "codex",
      patchText: "diff --git a/codex.txt b/codex.txt\n",
      summary: "updated the Codex fixture",
      parser: "codex",
    });
  });

  it("fails cleanly for unsupported backend names and preserves backend context", () => {
    const result = parseBackendEnvelope(
      envelope({ backend: "gemini", rawJson: '{"patchText":"diff"}' }),
    );

    expect(result).toMatchObject({
      ok: false,
      spawnId: "20260521-abc123",
      backend: "gemini",
      failureReason: "backend-unsupported",
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("fails cleanly for malformed backend JSON without echoing raw output", () => {
    const longRaw = "{".repeat(2_000);
    const result = parseBackendEnvelope(
      envelope({ backend: "claude-code", rawJson: longRaw }),
    );

    expect(result).toMatchObject({
      ok: false,
      backend: "claude-code",
      failureReason: "json-malformed",
    });
    expect(result).not.toHaveProperty("candidate");
    if (result.ok) throw new Error("expected malformed JSON failure");
    expect(result.diagnostic.length).toBeLessThan(1_100);
    expect(result.diagnostic).not.toContain("{".repeat(1_500));
  });

  it("fails cleanly when backend output has no patch field", () => {
    const result = parseBackendEnvelope(
      envelope({
        backend: "codex",
        rawJson: JSON.stringify({ type: "turn.completed", summary: "done" }),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      failureReason: "patch-absent",
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("fails cleanly when backend output contains ambiguous candidate patches", () => {
    const result = parseBackendEnvelope(
      envelope({
        backend: "codex",
        rawJson: JSON.stringify({
          candidates: [
            { patchText: "diff --git a/one.txt b/one.txt\n" },
            { patchText: "diff --git a/two.txt b/two.txt\n" },
          ],
        }),
      }),
    );

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      failureReason: "patch-ambiguous",
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("fails cleanly on deeply nested backend JSON without overflowing the stack", () => {
    // Valid JSON, within a plausible size cap, but nested far past the native
    // recursion limit — a recursive walk would throw RangeError outside the
    // parse boundary and crash the caller.
    const depth = 50_000;
    const deeplyNested = "[".repeat(depth) + "]".repeat(depth);

    const result = parseBackendEnvelope(
      envelope({ backend: "codex", rawJson: deeplyNested }),
    );

    expect(result).toMatchObject({
      ok: false,
      backend: "codex",
      failureReason: "patch-absent",
    });
    expect(result).not.toHaveProperty("candidate");
  });

  it("does not validate patch paths or persist extraction results", () => {
    const absolutePathPatch = [
      "diff --git a//tmp/evil.txt b//tmp/evil.txt",
      "--- a//tmp/evil.txt",
      "+++ b//tmp/evil.txt",
      "@@ -0,0 +1 @@",
      "+candidate only",
      "",
    ].join("\n");

    const result = parseBackendEnvelope(
      envelope({
        backend: "claude-code",
        rawJson: JSON.stringify({ patchText: absolutePathPatch }),
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.diagnostic);
    expect(result.candidate.patchText).toBe(absolutePathPatch);
    expect(result.candidate).not.toHaveProperty("touchedPaths");
    expect(result.candidate).not.toHaveProperty("sha256");
  });
});
