/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManagerPrompt,
  buildSpawnCommitPrompt,
  createHatcherySpawnArtifacts,
  evaluateStewardHandoffEligibility,
  extractPatchFromSpawnOutput,
  hatcherySpawnLogDir,
  managerBranchName,
  validateHatcherySpawnBackend,
} from "./spawn-handoff.js";
import type { DispatchTrace } from "../observability/spawn-trace.js";
import type { ExtractionResult } from "../brood/spawn-record.js";
import { claudeCodeBackend, codexBackend, PATCH_SENTINEL } from "../spawn/backends.js";

/** Encode a patch the way the in-container wrapper does: one sentinel line. */
function sentinelLine(patch: string): string {
  return `${PATCH_SENTINEL}:${Buffer.from(patch, "utf-8").toString("base64")}`;
}

// The launched-session race guard + worktree-dir derivation now live in the
// Castra adapter (src/castra/adapter.ts) — the Hatchery drives launches through
// Castra over HTTP rather than picking the session itself. Their unit coverage
// lives in src/castra/adapter.test.ts.

describe("spawn-handoff", () => {
  const tmpDirs: string[] = [];

  function makeTmpDir(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "march-handoff-test-"));
    tmpDirs.push(dir);
    return dir;
  }

  afterEach(() => {
    for (const dir of tmpDirs) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs.length = 0;
  });

  it("derives manager branch and log dir from the spawn id", () => {
    expect(managerBranchName("20260514-abcdef")).toBe(
      "march/spawn/20260514-abcdef",
    );
    expect(hatcherySpawnLogDir("20260514-abcdef", "/tmp/home")).toBe(
      path.join("/tmp/home", ".march", "logs", "hatchery-spawns", "20260514-abcdef"),
    );
  });

  it("instructs the worker to commit (not hand-write a patch) and never use gh", () => {
    const prompt = buildSpawnCommitPrompt("Change the README.");
    expect(prompt).toContain("Operator request:\nChange the README.");
    expect(prompt).toContain("Hatchery instructions:");
    expect(prompt).toContain("git add -A && git commit");
    expect(prompt).toContain("`[ ]` to `[x]`");
    // The worker must not push, open a PR, run gh, or hand-render a patch.
    expect(prompt).toMatch(/Do NOT push.*`gh`/s);
    expect(prompt).toMatch(/Do NOT hand-write, print, or paste a diff\/patch/);
    expect(prompt).not.toContain("git apply");
  });

  it("decodes the base64 patch from the wrapper's sentinel line", () => {
    const fullPatch =
      "diff --git a/README.md b/README.md\n" +
      "--- a/README.md\n" +
      "+++ b/README.md\n" +
      "@@ -1 +1 @@\n" +
      "-old\n" +
      "+new\n";
    const output = [
      '{"type":"turn.started"}',
      '{"type":"item.completed","item":{"type":"agent_message","text":"Committed the change."}}',
      sentinelLine(fullPatch),
    ].join("\n");
    expect(extractPatchFromSpawnOutput(output)).toBe(fullPatch);
  });

  it("reads the LAST sentinel line when more than one is present", () => {
    const stale = "diff --git a/old b/old\n--- a/old\n+++ b/old\n";
    const fresh = "diff --git a/new b/new\n--- a/new\n+++ b/new\n";
    const output = [sentinelLine(stale), "noise", sentinelLine(fresh)].join("\n");
    expect(extractPatchFromSpawnOutput(output)).toBe(fresh);
  });

  it("preserves a trailing whitespace-only context line through base64 decode", () => {
    // A hunk header like `@@ -1,3 +1,3 @@` requires 3 lines on each side; if the
    // final line is a blank context line (just " \n"), dropping it makes git
    // apply reject the patch as corrupt. base64 round-trips bytes exactly.
    const fullPatch =
      "diff --git a/file.md b/file.md\n" +
      "--- a/file.md\n" +
      "+++ b/file.md\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-old line\n" +
      "+new line\n" +
      " \n";
    expect(extractPatchFromSpawnOutput(sentinelLine(fullPatch))).toBe(fullPatch);
  });

  it("throws a clear error when no sentinel line is present", () => {
    expect(() =>
      extractPatchFromSpawnOutput(
        '{"type":"agent_message","text":"I made some changes."}\n',
      ),
    ).toThrow(/no committed patch/);
    expect(() => extractPatchFromSpawnOutput("")).toThrow(PATCH_SENTINEL);
  });

  it("rejects a decoded payload that is not a git diff", () => {
    expect(() =>
      extractPatchFromSpawnOutput(sentinelLine("not actually a diff\n")),
    ).toThrow(/did not decode to a git diff/);
  });

  it("rejects a patch that touches an absolute or parent-escaping path", () => {
    const absolute =
      "diff --git a/etc/passwd b//etc/passwd\n--- a/etc/passwd\n+++ b//etc/passwd\n";
    expect(() => extractPatchFromSpawnOutput(sentinelLine(absolute))).toThrow(
      /unsafe path/,
    );
    const escape =
      "diff --git a/../outside b/../outside\n--- a/../outside\n+++ b/../outside\n";
    expect(() => extractPatchFromSpawnOutput(sentinelLine(escape))).toThrow(
      /unsafe path/,
    );
  });

  it("manager prompt enumerates push and PR creation as separate atomic steps", () => {
    // Regression guard for the steward-strands-after-push bug. The previous
    // prompt combined commit + push + open PR in one step; in production
    // sonnet sometimes ended its turn after the successful push tool result,
    // leaving the workflow stranded with no PR. Splitting the workflow into
    // atomic steps and explicitly forbidding mid-task exit fixes this.
    //
    // Steps 4 and 5 now sit between the verification and the commit, so the
    // terminal-action numbering is 6/7/8/9 (not 4/5/6/7).
    const prompt = buildManagerPrompt({ operatorPrompt: "Do the work." });
    // Each terminal action gets its own numbered step so claude can't
    // consider "step N complete" after just the commit.
    expect(prompt).toMatch(/6\. Commit/);
    expect(prompt).toMatch(/7\. Push/);
    expect(prompt).toMatch(/8\. Open the PR using the `steward-pr` skill/);
    expect(prompt).toMatch(/9\. Report the PR URL/);
    // The mid-task-exit prohibition must be present in plain language so
    // claude reads it during planning, not just as boilerplate.
    expect(prompt).toMatch(/do NOT end your turn/i);
    expect(prompt).toContain("NEED:");
    expect(prompt).toContain("stranded steward");
    // No combined "commit + push + open PR" step survives in the commit step.
    expect(prompt).not.toMatch(/6\.[^\n]*push[^\n]*PR/);
  });

  it("manager prompt requires verifying completion and ticking tasks.md boxes", () => {
    // Regression guard for the "merged PR but tasks.md row still `[ ]`" drift
    // that wedges the deterministic loop: the loop dedups future dispatches
    // off the merged slice id, so any unchecked rows are silently abandoned.
    // The handoff prompt must force the steward to (a) confirm acceptance
    // criteria are actually met and (b) flip the matching tasks.md rows.
    const prompt = buildManagerPrompt({ operatorPrompt: "Do the work." });
    expect(prompt).toMatch(/4\. Confirm the work is actually complete/);
    expect(prompt).toMatch(/5\. Verify the work is marked complete/);
    expect(prompt).toMatch(/`\[ \]` to `\[x\]`/);
    expect(prompt).toContain("dedup-blocks-re-dispatch");
  });

  it("validates selected backend auth without exposing secret values or paths", () => {
    const oldAnthropic = process.env.ANTHROPIC_API_KEY;
    const oldCodexHome = process.env.CODEX_HOME;
    try {
      process.env.ANTHROPIC_API_KEY = "";
      expect(() => validateHatcherySpawnBackend(claudeCodeBackend)).toThrow(
        /Backend "claude-code" requires ANTHROPIC_API_KEY: missing ANTHROPIC_API_KEY/,
      );

      const missingCodexHome = path.join(makeTmpDir(), "missing-codex-home");
      process.env.CODEX_HOME = missingCodexHome;
      expect(() => validateHatcherySpawnBackend(codexBackend)).toThrow(
        /Backend "codex" requires Codex credential directory: missing Codex credential directory/,
      );
      try {
        validateHatcherySpawnBackend(codexBackend);
      } catch (err) {
        const message = (err as Error).message;
        expect(message).not.toContain(missingCodexHome);
        expect(message).not.toContain("CODEX_HOME");
      }
    } finally {
      if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = oldAnthropic;
      if (oldCodexHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = oldCodexHome;
    }
  });

  it("writes handoff artifacts from validated patch input and bounded metadata", () => {
    const home = makeTmpDir();
    const artifactDir = hatcherySpawnLogDir("20260514-abcdef", home);
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    const prompt = buildManagerPrompt({
      operatorPrompt: "Do the work.",
      patchPath: path.join(artifactDir, "patch.diff"),
      spawnOutputPath: path.join(artifactDir, "spawn-output.log"),
      metadataPath: path.join(artifactDir, "metadata.json"),
    });
    const artifacts = createHatcherySpawnArtifacts({
      spawnId: "20260514-abcdef",
      homeDir: home,
      spawnOutput: "spawn log",
      patch,
      managerPrompt: prompt,
      metadata: {
        spawnId: "20260514-abcdef",
        handoff: {
          source: "extraction-result",
          patchInput: "validated-patch",
          spawnId: "20260514-abcdef",
          backend: "codex",
          touchedPaths: ["a"],
          patchSha256: "abc123",
          extractedAt: "2026-06-13T00:00:00.000Z",
          diagnostic:
            "Patch artifact is validated ExtractionResult.patch.patchText; raw backend output is diagnostic-only.",
        },
      },
    });

    expect(fs.readFileSync(artifacts.patchPath, "utf-8")).toBe(patch);
    expect(fs.readFileSync(artifacts.spawnOutputPath, "utf-8")).toBe("spawn log");
    const writtenPrompt = fs.readFileSync(artifacts.managerPromptPath, "utf-8");
    expect(writtenPrompt).toContain("Review the already-applied staged change");
    expect(writtenPrompt).toContain(
      `Patch input: ${artifacts.patchPath} (validated ExtractionResult.patch.patchText; already applied).`,
    );
    expect(writtenPrompt).toContain("do not use it as patch input");
    const metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, "utf-8"));
    expect(metadata.artifacts.patchPath).toBe(artifacts.patchPath);
    expect(metadata.handoff).toMatchObject({
      source: "extraction-result",
      patchInput: "validated-patch",
      spawnId: "20260514-abcdef",
      backend: "codex",
      touchedPaths: ["a"],
      patchSha256: "abc123",
      extractedAt: "2026-06-13T00:00:00.000Z",
    });
  });

  describe("Steward handoff eligibility", () => {
    function successfulExtraction(
      patchText =
        "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
      touchedPaths: readonly string[] = ["a.txt"],
    ): ExtractionResult {
      return {
        spawnId: "spawn-1",
        backend: "codex",
        status: "succeeded",
        patch: {
          spawnId: "spawn-1",
          backend: "codex",
          patchText,
          touchedPaths,
          sha256: "abc123",
        },
        extractedAt: "2026-06-13T00:00:00.000Z",
      };
    }

    function failedExtraction(): ExtractionResult {
      return {
        spawnId: "spawn-1",
        backend: "codex",
        status: "failed",
        failureReason: "malformed_output",
        diagnostic: "no committed patch",
        extractedAt: "2026-06-13T00:00:00.000Z",
      };
    }

    function fakeDispatch() {
      const spans: Array<{
        name: string;
        errored: boolean;
        attributes: Record<string, unknown>;
      }> = [];
      const dispatch: DispatchTrace = {
        enabled: true,
        spanContext: () => undefined,
        span: (name, fn) => {
          const recorded: {
            name: string;
            errored: boolean;
            attributes: Record<string, unknown>;
          } = { name, errored: false, attributes: {} };
          spans.push(recorded);
          const handle = {
            setAttributes: (attributes: Record<string, unknown>) => {
              recorded.attributes = { ...recorded.attributes, ...attributes };
            },
            setError: () => {},
            spanContext: () => undefined,
          };
          try {
            return fn(handle);
          } catch (err) {
            recorded.errored = true;
            throw err;
          }
        },
        spanAsync: async (_name, fn) =>
          fn({ setAttributes: () => {}, setError: () => {}, spanContext: () => undefined }),
        setAttributes: () => {},
        recordException: () => {},
        traceparent: () => undefined,
        end: () => {},
      };
      return { dispatch, spans };
    }

    it("exposes only validated patch fields for a successful extraction", () => {
      const { dispatch, spans } = fakeDispatch();
      const result = evaluateStewardHandoffEligibility({
        spawnId: "spawn-1",
        dispatch,
        readExtractionResult: () => successfulExtraction(),
      });

      expect(result).toEqual({
        eligible: true,
        handoff: {
          spawnId: "spawn-1",
          backend: "codex",
          patchText:
            "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-a\n+b\n",
          patchSha256: "abc123",
          touchedPaths: ["a.txt"],
          extractedAt: "2026-06-13T00:00:00.000Z",
        },
      });
      expect(spans).toHaveLength(1);
      expect(spans[0]).toMatchObject({
        name: "steward.handoff_eligibility",
        errored: false,
      });
      expect(spans[0].attributes).toMatchObject({
        "march.handoff.eligible": true,
        "march.handoff.reason": "ready",
        "march.extraction.status": "succeeded",
      });
    });

    it("refuses failed extraction with bounded metadata and an errored span", () => {
      const { dispatch, spans } = fakeDispatch();
      const result = evaluateStewardHandoffEligibility({
        spawnId: "spawn-1",
        dispatch,
        readExtractionResult: () => failedExtraction(),
      });

      expect(result).toMatchObject({
        eligible: false,
        reason: "failed",
        failureReason: "malformed_output",
        backend: "codex",
        extractedAt: "2026-06-13T00:00:00.000Z",
      });
      if (result.eligible) throw new Error("expected handoff refusal");
      expect(result.diagnostic).toContain("no committed patch");
      expect(spans[0]).toMatchObject({
        name: "steward.handoff_eligibility",
        errored: true,
      });
      expect(spans[0].attributes).toMatchObject({
        "march.handoff.eligible": false,
        "march.handoff.reason": "failed",
        "march.extraction.status": "failed",
      });
    });

    it("refuses missing extraction state with an errored span", () => {
      const { dispatch, spans } = fakeDispatch();
      const result = evaluateStewardHandoffEligibility({
        spawnId: "spawn-1",
        dispatch,
        readExtractionResult: () => undefined,
      });

      expect(result).toMatchObject({
        eligible: false,
        reason: "missing",
      });
      if (result.eligible) throw new Error("expected handoff refusal");
      expect(result.diagnostic).toContain("extraction result is missing");
      expect(spans[0]).toMatchObject({
        name: "steward.handoff_eligibility",
        errored: true,
      });
      expect(spans[0].attributes).toMatchObject({
        "march.handoff.eligible": false,
        "march.handoff.reason": "missing",
        "march.extraction.status": "missing",
      });
    });

    it("refuses empty or normalized no-op successful extraction with errored spans", () => {
      for (const extractionResult of [
        successfulExtraction("   \n", ["a.txt"]),
        successfulExtraction("diff --git a/a.txt b/a.txt\n", []),
        // Header-only patch with a non-empty computed touchedPaths list (the
        // shape extractionSuccessResult() really produces) — no hunk, so it
        // must still be rejected as no-op (#350 review).
        successfulExtraction("diff --git a/a.txt b/a.txt\n", ["a.txt"]),
        successfulExtraction("not a git diff\n", ["a.txt"]),
      ]) {
        const { dispatch, spans } = fakeDispatch();
        const result = evaluateStewardHandoffEligibility({
          spawnId: "spawn-1",
          dispatch,
          readExtractionResult: () => extractionResult,
        });

        expect(result).toMatchObject({
          eligible: false,
          reason: "noop",
        });
        if (result.eligible) throw new Error("expected handoff refusal");
        expect(result.diagnostic).toContain("empty or no-op");
        expect(spans[0]).toMatchObject({
          name: "steward.handoff_eligibility",
          errored: true,
        });
        expect(spans[0].attributes).toMatchObject({
          "march.handoff.eligible": false,
          "march.handoff.reason": "noop",
          "march.extraction.status": "succeeded",
        });
      }
    });
  });
});
