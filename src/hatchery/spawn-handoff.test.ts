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

  it("writes handoff artifacts and includes paths in the manager prompt", () => {
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
      "Apply and review the staged spawn patch",
    );
    const metadata = JSON.parse(fs.readFileSync(artifacts.metadataPath, "utf-8"));
    expect(metadata.artifacts.patchPath).toBe(artifacts.patchPath);
  });
});
