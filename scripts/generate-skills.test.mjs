/**
 * Unit tests for the march.* skill generator.
 *
 * @l0
 * @deterministic
 * @ci
 */
import { describe, expect, it, beforeAll, afterAll } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CONTEXTS,
  SKILLS,
  outputName,
  renderPromptText,
  loadSnippets,
  generateSkill,
} from "./generate-skills.mjs";

describe("outputName", () => {
  it("strips .prompt, defaulting an extensionless result to .md", () => {
    expect(outputName("SKILL.prompt")).toBe("SKILL.md");
    expect(outputName("lib.sh.prompt")).toBe("lib.sh");
    expect(outputName("fold-state.sh")).toBe("fold-state.sh");
    expect(outputName("status.json")).toBe("status.json");
  });
});

describe("renderPromptText", () => {
  const partials = {
    addr: "endpoint: {{{HERALD_BASE}}}{{#if IS_CONTAINER}} (container){{/if}}",
  };
  const vars = { HERALD_BASE: "http://herald:8818", IS_CONTAINER: true, CONTEXT: "castra" };

  it("substitutes vars in BOTH frontmatter and body and resolves partials", async () => {
    const src = [
      "---",
      "name: demo",
      "allowed-tools: Bash(curl -s {{{HERALD_BASE}}}/*)",
      "---",
      "# Context {{CONTEXT}}",
      "",
      "{{>addr}}",
      "",
    ].join("\n");
    const out = await renderPromptText(src, partials, vars);
    expect(out).toContain("allowed-tools: Bash(curl -s http://herald:8818/*)");
    expect(out).toContain("# Context castra");
    expect(out).toContain("endpoint: http://herald:8818 (container)");
    expect(out).not.toContain("{{");
  });

  it("omits {{#if}} blocks when the flag is false", async () => {
    const out = await renderPromptText("{{>addr}}", partials, {
      HERALD_BASE: "http://localhost:8818",
      IS_CONTAINER: false,
    });
    expect(out).toContain("endpoint: http://localhost:8818");
    expect(out).not.toContain("(container)");
  });

  it("renders a source with no frontmatter", async () => {
    const out = await renderPromptText("base={{{HERALD_BASE}}}", {}, { HERALD_BASE: "x" });
    expect(out).toBe("base=x");
  });
});

describe("CONTEXTS", () => {
  it("bakes localhost for repo and docker hostnames for castra", () => {
    const repo = CONTEXTS.find((c) => c.id === "repo");
    const castra = CONTEXTS.find((c) => c.id === "castra");
    expect(repo.vars.HERALD_BASE).toBe("http://localhost:8818");
    expect(repo.vars.LEGATE_BASE).toBe("http://localhost:8787");
    expect(repo.committed).toBe(true);
    expect(castra.vars.HERALD_BASE).toBe("http://herald:8818");
    expect(castra.vars.LEGATE_BASE).toBe("http://legate:8787");
    expect(castra.committed).toBe(false);
  });
});

describe("generateSkill (full render against the real sources)", () => {
  let outRoot;
  let snippets;

  beforeAll(async () => {
    outRoot = await fs.mkdtemp(path.join(os.tmpdir(), "march-skills-"));
    snippets = await loadSnippets();
  });
  afterAll(async () => {
    await fs.rm(outRoot, { recursive: true, force: true });
  });

  it("loads the shared service-addressing partial", () => {
    expect(snippets["service-addressing"]).toBeTruthy();
  });

  it("emits a complete, mustache-free variant per context with the right baked URLs", async () => {
    for (const context of CONTEXTS) {
      const files = await generateSkill({ skill: "march.debug", context, outRoot, snippets });
      const skillDir = path.join(outRoot, context.outDir, "march.debug");

      // Every shipped file renders clean (no leftover handlebars).
      for (const rel of files) {
        const body = await fs.readFile(path.join(outRoot, rel), "utf8");
        expect(body, `${rel} has unresolved mustaches`).not.toContain("{{");
      }

      const lib = await fs.readFile(path.join(skillDir, "scripts", "lib.sh"), "utf8");
      const skill = await fs.readFile(path.join(skillDir, "SKILL.md"), "utf8");
      expect(lib).toContain(`HERALD_DEFAULT_URL="${context.vars.HERALD_BASE}"`);
      expect(lib).toContain(`LEGATE_DEFAULT_URL="${context.vars.LEGATE_BASE}"`);
      expect(skill).toContain(`Bash(curl -s ${context.vars.HERALD_BASE}/*)`);

      // No runtime context detection survives in the shipped lib (issue #424).
      expect(lib).not.toMatch(/\.dockerenv|in_container|resolve_url/);

      if (context.id === "repo") {
        expect(lib).not.toContain("http://herald:8818");
        expect(skill).not.toContain("inside the Castra container");
      } else {
        expect(lib).not.toContain("http://localhost:8818");
        expect(skill).toContain("inside the Castra container");
      }

      // The fixtures used by the self-test harness are carried verbatim.
      const replay = path.join(skillDir, "scripts", "fixtures", "replay", "state.json");
      expect((await fs.stat(replay)).isFile()).toBe(true);
    }
  });

  it("declares march.debug as a generated skill", () => {
    expect(SKILLS).toContain("march.debug");
  });
});
