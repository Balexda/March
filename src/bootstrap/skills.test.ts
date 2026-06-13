/**
 * @l0 @deterministic @ci
 */
import { describe, it, expect } from "vitest";
import { getM1Skills, type MarchSkill } from "./skills.js";

describe("MarchSkill interface and getM1Skills", () => {
  it("returns exactly 3 skills", () => {
    const skills: MarchSkill[] = getM1Skills();
    expect(skills).toHaveLength(3);
  });

  it("returns skills with all required fields", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      expect(skill).toHaveProperty("filename");
      expect(skill).toHaveProperty("category");
      expect(skill).toHaveProperty("deployTarget");
      expect(skill).toHaveProperty("agent");
      expect(skill).toHaveProperty("content");
    }
  });

  it("all filenames start with march. and end with .md", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      expect(skill.filename).toMatch(/^march\.[a-z0-9-]+\.md$/);
    }
  });

  it("all skills target agent claude", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      expect(skill.agent).toBe("claude");
    }
  });

  it("includes spawn-dispatch skill targeting .claude/commands", () => {
    const skills = getM1Skills();
    const spawnDispatch = skills.find((s) => s.category === "spawn-dispatch");
    expect(spawnDispatch).toBeDefined();
    expect(spawnDispatch!.filename).toBe("march.spawn-dispatch.md");
    expect(spawnDispatch!.deployTarget).toBe(".claude/commands");
  });

  it("includes spawn-status skill targeting .claude/commands", () => {
    const skills = getM1Skills();
    const spawnStatus = skills.find((s) => s.category === "spawn-status");
    expect(spawnStatus).toBeDefined();
    expect(spawnStatus!.filename).toBe("march.spawn-status.md");
    expect(spawnStatus!.deployTarget).toBe(".claude/commands");
  });

  it("includes output-handling skill targeting .claude/prompts", () => {
    const skills = getM1Skills();
    const outputHandling = skills.find((s) => s.category === "output-handling");
    expect(outputHandling).toBeDefined();
    expect(outputHandling!.filename).toBe("march.output-handling.md");
    expect(outputHandling!.deployTarget).toBe(".claude/prompts");
  });

  it("deploy targets are relative paths without leading ~/ or /", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      expect(skill.deployTarget).not.toMatch(/^[~/]/);
    }
  });

  it("each skill has non-empty placeholder markdown content", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      expect(skill.content.length).toBeGreaterThan(0);
      expect(skill.content).toContain("#");
    }
  });

  it("each skill content opens with an H1 heading with non-empty text", () => {
    const skills = getM1Skills();
    for (const skill of skills) {
      const firstLine = skill.content.trimStart().split("\n")[0];
      expect(
        firstLine,
        `${skill.filename} content must open with an H1 heading with non-empty text (e.g. "# My Title")`,
      ).toMatch(/^# \S/);
    }
  });

  it("spawn-dispatch content has correct title and placeholder text", () => {
    const skills = getM1Skills();
    const skill = skills.find((s) => s.category === "spawn-dispatch")!;
    expect(skill.content).toContain("# March: Spawn Dispatch");
    expect(skill.content).toContain("placeholder");
  });

  it("spawn-status content has correct title and placeholder text", () => {
    const skills = getM1Skills();
    const skill = skills.find((s) => s.category === "spawn-status")!;
    expect(skill.content).toContain("# March: Spawn Status");
    expect(skill.content).toContain("placeholder");
  });

  it("output-handling content has correct title and placeholder text", () => {
    const skills = getM1Skills();
    const skill = skills.find((s) => s.category === "output-handling")!;
    expect(skill.content).toContain("# March: Output Handling");
    expect(skill.content).toContain("placeholder");
  });
});
