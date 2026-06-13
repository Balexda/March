import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureStewardSkills, stewardSkillsRoot } from "./steward-skills.js";

const prevOverride = process.env.MARCH_STEWARD_SKILLS_DIR;

afterEach(() => {
  if (prevOverride === undefined) delete process.env.MARCH_STEWARD_SKILLS_DIR;
  else process.env.MARCH_STEWARD_SKILLS_DIR = prevOverride;
});

describe("stewardSkillsRoot", () => {
  it("defaults to ~/.march/steward", () => {
    delete process.env.MARCH_STEWARD_SKILLS_DIR;
    expect(stewardSkillsRoot()).toBe(path.join(os.homedir(), ".march", "steward"));
  });

  it("honors the MARCH_STEWARD_SKILLS_DIR override", () => {
    process.env.MARCH_STEWARD_SKILLS_DIR = "/custom/steward";
    expect(stewardSkillsRoot()).toBe("/custom/steward");
  });
});

describe("ensureStewardSkills", () => {
  it("materializes the steward-pr skill under <root>/.claude/skills and is idempotent", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "steward-skills-"));
    process.env.MARCH_STEWARD_SKILLS_DIR = root;

    const returned = await ensureStewardSkills();
    expect(returned).toBe(root);

    const skillPath = path.join(root, ".claude", "skills", "steward-pr", "SKILL.md");
    const body = await fsp.readFile(skillPath, "utf-8");
    expect(body).toContain("name: steward-pr");
    // The skill encodes the title rule (no `smithy ` prefix, no US/S numbers).
    expect(body).toContain("<verb>: <concise goal>");

    // Re-running overwrites cleanly rather than throwing.
    await expect(ensureStewardSkills()).resolves.toBe(root);
    expect(fs.existsSync(skillPath)).toBe(true);

    await fsp.rm(root, { recursive: true, force: true });
  });
});
