/**
 * @l1 @deterministic @ci
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManagerPrompt,
  planningVerbOf,
  steeringQuestionsFrom,
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
    // Git's quoted header form must not slip past the safety check (#735 review).
    const quotedEscape =
      'diff --git "a/../caf\\303\\251" "b/../caf\\303\\251"\n--- "a/../caf\\303\\251"\n+++ "b/../caf\\303\\251"\n';
    expect(() => extractPatchFromSpawnOutput(sentinelLine(quotedEscape))).toThrow(
      /unsafe path/,
    );
  });

  it("asks the Steward to verify the published commit and escalate corrections", () => {
    const prompt = buildManagerPrompt({ operatorPrompt: "Do the work.", reviewId: "review-id" });
    expect(prompt).toContain("Review the published commit");
    expect(prompt).toContain("every acceptance criterion");
    expect(prompt).toContain("`[ ]` to `[x]`");
    expect(prompt).toContain("NEED:");
    expect(prompt).toContain("Do not edit, commit, or push");
    expect(prompt).toContain("exact published branch");
    expect(prompt).toContain("Review receipt ID: review-id");
    expect(prompt).toContain("REVIEW <receipt ID> <passed|unavailable|failed>");
  });

  describe("steering check for planning stewards", () => {
    const cutRequest = "Complete this Smithy workflow step and produce a git patch.\n\nSmithy command:\nsmithy.cut specs/tessera/spec.md 3";
    const forgeRequest = "Complete this Smithy workflow step and produce a git patch.\n\nSmithy command:\nsmithy.forge specs/tessera/us3.tasks.md 1";

    it("requires a cut steward to escalate a slice gate on an unresolved decision", () => {
      const prompt = buildManagerPrompt({ operatorPrompt: cutRequest, reviewId: "review-id" });
      expect(prompt).toContain("Steering check (this is a planning step: smithy.cut)");
      expect(prompt).toContain("gates any slice on an unresolved decision");
      expect(prompt).toContain("must not be forged until SD-001 is resolved");
      expect(prompt).toContain("do not report it as done");
      expect(prompt).toContain("begins with STEERING:");
      expect(prompt).toContain("its options with their trade-offs");
      expect(prompt).toContain("the slices it blocks");
      expect(prompt).toContain("REVIEW <receipt ID> <passed|unavailable|failed|steering>");
      expect(prompt).toContain("march:needs-steering");
      // After the answer: apply it, remove the gate and the label.
      expect(prompt).toContain("remove the gate");
      expect(prompt).toContain("--remove-label march:needs-steering");
      expect(prompt).toContain("`gh pr ready <number>`");
      // Plain debt is explicitly not a reason to escalate.
      expect(prompt).toContain("Ordinary specification debt is NOT a reason to escalate");
      // No line of the prompt itself parses as a steering question.
      expect(steeringQuestionsFrom(prompt)).toEqual([]);
    });

    it("leaves code verbs on the plain receipt", () => {
      const prompt = buildManagerPrompt({ operatorPrompt: forgeRequest, reviewId: "review-id" });
      expect(prompt).not.toContain("Steering check");
      expect(prompt).toContain("REVIEW <receipt ID> <passed|unavailable|failed>.");
    });

    it("finds the planning verb from the command, else the slice id suffix", () => {
      expect(planningVerbOf(cutRequest)).toBe("cut");
      expect(planningVerbOf(forgeRequest, "x-cut")).toBeUndefined();
      expect(planningVerbOf("Do the work.", "tessera-us3-cut")).toBe("cut");
      expect(planningVerbOf("Do the work.", "tessera-us3-s1-forge")).toBeUndefined();
    });

    it("collects the steward's STEERING: lines, deduplicated", () => {
      const output = ["noise", "  STEERING: SD-001 where do secrets live? Blocks: slice 1", "STEERING: SD-001 where do secrets live? Blocks: slice 1",
        "STEERING:", "STEERING: SD-006 rotation owner? Blocks: slice 1"].join("\n");
      expect(steeringQuestionsFrom(output)).toEqual([
        "SD-001 where do secrets live? Blocks: slice 1", "SD-006 rotation owner? Blocks: slice 1",
      ]);
    });

    it("ships the same rules in the steward-pr skill", () => {
      const skill = fs.readFileSync(new URL("../templates/steward/skills/steward-pr/SKILL.md", import.meta.url), "utf8");
      expect(skill).toContain("## Steering check (planning steps)");
      expect(skill).toContain("gates any slice on");
      expect(skill).toContain("an unresolved decision");
      expect(skill).toContain("`STEERING:`");
      expect(skill).toContain("`steering` receipt status");
      expect(skill).toContain("`march:needs-steering`");
      expect(skill).toContain("--remove-label march:needs-steering");
      expect(skill).toContain("`gh pr ready <number>`");
      expect(skill).toContain("Ordinary specification debt is not a reason to escalate.");
      expect(skill).toContain("Never use it for ordinary spec debt.");
    });
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
    expect(writtenPrompt).toContain("Review the published commit");
    expect(writtenPrompt).toContain(
      `Patch input: ${artifacts.patchPath} (validated ExtractionResult.patch.patchText; already published).`,
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
