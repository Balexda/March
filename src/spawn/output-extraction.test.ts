import { describe, expect, it } from "vitest";
import {
  parseBackendEnvelope,
  validateSpawnOutput,
  validateSpawnPatch,
  type SpawnOutputValidationFailure,
} from "./output-extraction.js";

const worktreePath = "/tmp/march-worktree";

const modifyPatch = [
  "diff --git a/src/app.ts b/src/app.ts",
  "index 1111111..2222222 100644",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1 +1 @@",
  "-old",
  "+new",
  "",
].join("\n");

function envelope(patchText: string): string {
  return JSON.stringify({ patchText, summary: "done" });
}

function expectFailure(result: unknown): SpawnOutputValidationFailure {
  expect(result).toMatchObject({ status: "failed" });
  return result as SpawnOutputValidationFailure;
}

describe("spawn output envelope parsing", () => {
  it("returns malformed-output for invalid backend JSON", () => {
    const result = parseBackendEnvelope("claude-code", "{not json");

    expectFailure(result);
    expect(result).toMatchObject({ category: "malformed-output" });
  });

  it("parses one Claude Code git patch candidate", () => {
    const result = parseBackendEnvelope("claude-code", envelope(modifyPatch));

    expect(result).toMatchObject({
      status: "candidate",
      patchText: modifyPatch,
      summary: "done",
    });
  });

  it("parses one Codex git patch candidate", () => {
    const result = parseBackendEnvelope(
      "codex",
      JSON.stringify({ items: [{ type: "message" }, { git_patch: modifyPatch }] }),
    );

    expect(result).toMatchObject({ status: "candidate", patchText: modifyPatch });
  });

  it("rejects output with no usable git patch", () => {
    const result = parseBackendEnvelope("codex", JSON.stringify({ message: "done" }));

    expect(result).toMatchObject({ status: "failed", category: "no-patch" });
  });

  it("rejects ambiguous multiple patch candidates", () => {
    const otherPatch = modifyPatch.replace("src/app.ts", "src/other.ts");
    const result = parseBackendEnvelope(
      "claude-code",
      JSON.stringify({ patch: modifyPatch, nested: { diff: otherPatch } }),
    );

    expect(result).toMatchObject({ status: "failed", category: "ambiguous-patch" });
  });

  it("does not introduce Gemini backend behavior", () => {
    const result = parseBackendEnvelope("gemini", envelope(modifyPatch));

    expect(result).toMatchObject({ status: "failed", category: "malformed-output" });
  });
});

describe("spawn patch validation", () => {
  it("accepts a relative in-worktree modify patch with stable paths and digest", () => {
    const first = validateSpawnPatch({ patchText: modifyPatch, worktreePath });
    const second = validateSpawnPatch({ patchText: modifyPatch, worktreePath });

    expect(first).toMatchObject({
      status: "accepted",
      patch: {
        patchText: modifyPatch,
        touchedPaths: ["src/app.ts"],
      },
    });
    expect(first.status === "accepted" && first.patch.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(first).toEqual(second);
  });

  it("accepts create, delete, rename, and mode-only patches", () => {
    const createPatch = [
      "diff --git a/new.txt b/new.txt",
      "new file mode 100644",
      "index 0000000..1111111",
      "--- /dev/null",
      "+++ b/new.txt",
      "@@ -0,0 +1 @@",
      "+new",
      "",
    ].join("\n");
    const deletePatch = [
      "diff --git a/old.txt b/old.txt",
      "deleted file mode 100644",
      "index 1111111..0000000",
      "--- a/old.txt",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-old",
      "",
    ].join("\n");
    const renamePatch = [
      "diff --git a/old.ts b/new.ts",
      "similarity index 100%",
      "rename from old.ts",
      "rename to new.ts",
      "",
    ].join("\n");
    const modeOnlyPatch = [
      "diff --git a/script.sh b/script.sh",
      "old mode 100644",
      "new mode 100755",
      "",
    ].join("\n");

    expect(validateSpawnPatch({ patchText: createPatch, worktreePath })).toMatchObject({
      status: "accepted",
      patch: { touchedPaths: ["new.txt"] },
    });
    expect(validateSpawnPatch({ patchText: deletePatch, worktreePath })).toMatchObject({
      status: "accepted",
      patch: { touchedPaths: ["old.txt"] },
    });
    expect(validateSpawnPatch({ patchText: renamePatch, worktreePath })).toMatchObject({
      status: "accepted",
      patch: { touchedPaths: ["new.ts", "old.ts"] },
    });
    expect(validateSpawnPatch({ patchText: modeOnlyPatch, worktreePath })).toMatchObject({
      status: "accepted",
      patch: { touchedPaths: ["script.sh"] },
    });
  });

  it("rejects absolute patch target paths", () => {
    const result = validateSpawnPatch({
      patchText: modifyPatch.replace("b/src/app.ts", "b//etc/passwd"),
      worktreePath,
    });

    expect(result).toMatchObject({ status: "failed", category: "unsafe-patch-path" });
  });

  it("rejects parent traversal patch target paths", () => {
    const result = validateSpawnPatch({
      patchText: modifyPatch.replaceAll("src/app.ts", "../outside.ts"),
      worktreePath,
    });

    expect(result).toMatchObject({ status: "failed", category: "unsafe-patch-path" });
  });

  it("allows safe relative names that merely start with dots", () => {
    const result = validateSpawnPatch({
      patchText: modifyPatch.replaceAll("src/app.ts", "..well-known/config.json"),
      worktreePath,
    });

    expect(result).toMatchObject({
      status: "accepted",
      patch: { touchedPaths: ["..well-known/config.json"] },
    });
  });

  it("rejects empty and no-op patches", () => {
    expect(validateSpawnPatch({ patchText: "", worktreePath })).toMatchObject({
      status: "failed",
      category: "empty-patch",
    });
    expect(
      validateSpawnPatch({
        patchText: "diff --git a/src/app.ts b/src/app.ts\n",
        worktreePath,
      }),
    ).toMatchObject({ status: "failed", category: "empty-patch" });
  });

  it("rejects unsupported patch forms", () => {
    const copyPatch = [
      "diff --git a/source.ts b/copy.ts",
      "similarity index 100%",
      "copy from source.ts",
      "copy to copy.ts",
      "",
    ].join("\n");

    expect(validateSpawnPatch({ patchText: copyPatch, worktreePath })).toMatchObject({
      status: "failed",
      category: "unsupported-patch-form",
    });
  });
});

describe("spawn output validation composition", () => {
  it("returns an accepted validation result for safe backend output", () => {
    const result = validateSpawnOutput({
      backend: "codex",
      rawJson: envelope(modifyPatch),
      worktreePath,
    });

    expect(result).toMatchObject({
      status: "accepted",
      patch: {
        patchText: modifyPatch,
        touchedPaths: ["src/app.ts"],
      },
    });
  });

  it("returns bounded failures without exposing a patch payload", () => {
    const result = validateSpawnOutput({
      backend: "claude-code",
      rawJson: "{".repeat(1000),
      worktreePath,
    });
    const failure = expectFailure(result);

    expect(failure.category).toBe("malformed-output");
    expect(failure.diagnostic.length).toBeLessThanOrEqual(240);
    expect("patch" in failure).toBe(false);
  });

  it("truncates an overlong diagnostic to the bound, ellipsis included", () => {
    const longPath = `/${"a".repeat(400)}`;
    const result = validateSpawnPatch({
      patchText: modifyPatch.replace("b/src/app.ts", `b/${longPath}`),
      worktreePath,
    });
    const failure = expectFailure(result);

    expect(failure.category).toBe("unsafe-patch-path");
    expect(failure.diagnostic.length).toBeLessThanOrEqual(240);
    expect(failure.diagnostic.endsWith("...")).toBe(true);
  });
});
