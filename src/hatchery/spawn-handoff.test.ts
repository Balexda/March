import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildManagerPrompt,
  buildSpawnPatchPrompt,
  createHatcherySpawnArtifacts,
  extractPatchFromSpawnOutput,
  hatcherySpawnLogDir,
  managerBranchName,
} from "./spawn-handoff.js";

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

  it("wraps the operator prompt with patch-output instructions", () => {
    const prompt = buildSpawnPatchPrompt("Change the README.");
    expect(prompt).toContain("Operator request:\nChange the README.");
    expect(prompt).toContain("diff --git");
    expect(prompt).toContain("git apply --index");
    expect(prompt).toContain("Hatchery instructions:");
  });

  it("extracts a patch from raw diff output", () => {
    const patch = extractPatchFromSpawnOutput(
      "notes before\n" +
        "diff --git a/README.md b/README.md\n" +
        "--- a/README.md\n" +
        "+++ b/README.md\n" +
        "@@ -1 +1 @@\n" +
        "-old\n" +
        "+new\n",
    );
    expect(patch.startsWith("diff --git")).toBe(true);
    expect(patch).toContain("+new");
  });

  it("extracts a patch from JSONL output", () => {
    const patch = extractPatchFromSpawnOutput(
      [
        JSON.stringify({ event: "started" }),
        JSON.stringify({
          result: {
            patch:
              "diff --git a/file.txt b/file.txt\n--- a/file.txt\n+++ b/file.txt\n",
          },
        }),
      ].join("\n"),
    );
    expect(patch).toContain("diff --git a/file.txt b/file.txt");
  });

  it("extracts a fenced patch from Codex JSONL agent messages without trailing event JSON", () => {
    const patch = extractPatchFromSpawnOutput(
      [
        JSON.stringify({ type: "turn.started" }),
        JSON.stringify({
          type: "item.completed",
          item: {
            type: "agent_message",
            text:
              "Created docs/README.md.\n\n```diff\n" +
              "diff --git a/docs/README.md b/docs/README.md\n" +
              "new file mode 100644\n" +
              "--- /dev/null\n" +
              "+++ b/docs/README.md\n" +
              "@@ -0,0 +1 @@\n" +
              "+hello\n" +
              "```",
          },
        }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
    );

    expect(patch).toBe(
      "diff --git a/docs/README.md b/docs/README.md\n" +
        "new file mode 100644\n" +
        "--- /dev/null\n" +
        "+++ b/docs/README.md\n" +
        "@@ -0,0 +1 @@\n" +
        "+hello\n",
    );
  });

  it("extracts a fenced patch whose body contains nested ```ts fences (added file contents)", () => {
    // Reproduces issue #131: codex emits a ```diff fence whose patch body
    // adds files containing their own ```ts/```diff fences. The closing ``` of
    // the OUTER fence is the only one preceded by a newline (inner fences are
    // prefixed by `+` because they are patch-added lines). Naive non-greedy
    // matching stops at the first inner fence and truncates the patch.
    const patch = extractPatchFromSpawnOutput(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text:
            "Done.\n\n```diff\n" +
            "diff --git a/docs/api.md b/docs/api.md\n" +
            "new file mode 100644\n" +
            "--- /dev/null\n" +
            "+++ b/docs/api.md\n" +
            "@@ -0,0 +1,7 @@\n" +
            "+# API\n" +
            "+\n" +
            "+```ts\n" +
            "+export function foo(): void;\n" +
            "+```\n" +
            "+\n" +
            "+End.\n" +
            "```",
        },
      }),
    );

    expect(patch).toContain("export function foo(): void;");
    expect(patch).toContain("+End.");
    expect(patch).toContain("+```ts");
    expect(patch.startsWith("diff --git a/docs/api.md")).toBe(true);
    // The patch must not be truncated at the inner ```ts fence.
    expect(patch).not.toMatch(/\n```\s*$/);
  });

  it("accepts an indented closing fence (CommonMark allows up to 3 spaces)", () => {
    // Defensive regression coverage for PR #135 review: a closing fence may
    // be written with leading spaces or tabs. The outer fence must still
    // match so we don't fall through to the raw `diff --git` marker path,
    // which would return the closing backticks and trailing prose verbatim
    // and produce an invalid patch.
    const patch = extractPatchFromSpawnOutput(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text:
            "Here:\n\n```diff\n" +
            "diff --git a/x b/x\n" +
            "--- a/x\n" +
            "+++ b/x\n" +
            "@@ -1 +1 @@\n" +
            "-a\n" +
            "+b\n" +
            "   ```\n" + // indented closing fence
            "trailing prose that must not leak into the patch",
        },
      }),
    );

    expect(patch.startsWith("diff --git a/x b/x")).toBe(true);
    expect(patch).not.toContain("```");
    expect(patch).not.toContain("trailing prose");
    expect(patch.endsWith("+b\n")).toBe(true);
  });

  it("preserves a trailing whitespace-only context line at the end of the patch", () => {
    // Reproduces issue #131: a hunk header like `@@ -43,7 +43,7 @@` requires
    // 7 lines on each side; if the final line is a blank context line (just
    // " \n"), trimEnd() strips it and git apply fails with "corrupt patch".
    const fullPatch =
      "diff --git a/file.md b/file.md\n" +
      "--- a/file.md\n" +
      "+++ b/file.md\n" +
      "@@ -1,3 +1,3 @@\n" +
      "-old line\n" +
      "+new line\n" +
      " \n"; // trailing blank context line — must survive extraction
    const patch = extractPatchFromSpawnOutput(
      JSON.stringify({
        type: "item.completed",
        item: {
          type: "agent_message",
          text: "Result:\n\n```diff\n" + fullPatch + "```",
        },
      }),
    );

    // The blank context line " \n" must be preserved so git apply sees the
    // hunk's full line count.
    expect(patch).toBe(fullPatch);
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
    expect(prompt).toMatch(/8\. Open the PR with `gh pr create`/);
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

  it("writes handoff artifacts and tells the manager the patch is already applied", () => {
    const home = makeTmpDir();
    const patch = "diff --git a/a b/a\n--- a/a\n+++ b/a\n";
    const prompt = buildManagerPrompt({
      operatorPrompt: "Do the work.",
      patchPath: path.join(home, "patch.diff"),
      spawnOutputPath: path.join(home, "spawn-output.log"),
      metadataPath: path.join(home, "metadata.json"),
    });
    const artifacts = createHatcherySpawnArtifacts({
      spawnId: "20260514-abcdef",
      homeDir: home,
      spawnOutput: "spawn log",
      patch,
      managerPrompt: prompt,
      metadata: { spawnId: "20260514-abcdef" },
    });

    expect(fs.readFileSync(artifacts.patchPath, "utf-8")).toBe(patch);
    expect(fs.readFileSync(artifacts.spawnOutputPath, "utf-8")).toBe("spawn log");
    expect(fs.readFileSync(artifacts.managerPromptPath, "utf-8")).toContain(
      "Review the already-applied staged change",
    );
    expect(fs.readFileSync(artifacts.managerPromptPath, "utf-8")).not.toContain(
      artifacts.patchPath,
    );
    const metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, "utf-8"));
    expect(metadata.artifacts.patchPath).toBe(artifacts.patchPath);
  });
});
