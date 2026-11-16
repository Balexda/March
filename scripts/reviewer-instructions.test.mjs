/**
 * @l0 @deterministic @ci
 */
// Guard for the reviewer instruction files under `.github/`.
//
// Automated reviewers (Copilot code review, Codex, CodeRabbit) read these files
// as their prompt, and they drop a malformed one silently: an instruction file with no
// `applyTo` is ignored, and a skill whose `name` does not match its directory
// is never loaded. Nothing reports the loss — the review simply gets worse.
// These checks hold the shape the reviewers require, the size GitHub
// recommends, and the boundary between the Smithy-general layer (`smithy.*`,
// `smithy-*`) and March's own rules. CodeRabbit reaches the same files through
// the path map in `.coderabbit.yaml`, which repeats each file's `applyTo`; the
// last block keeps that map in step. The layout is described in
// `docs/reviewer-instructions.md`.
//
// Every check is paired with a planted-defect test: a guard that stopped
// looking passes exactly like a clean tree. The plants are in-memory strings,
// so nothing in the tracked tree is written.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const githubDir = path.join(repoRoot, ".github");
const instructionsDir = path.join(githubDir, "instructions");
const skillsDir = path.join(githubDir, "skills");

/** GitHub's guidance for a custom instruction file read during code review. */
const INSTRUCTION_CHAR_BUDGET = 4000;

/** Word budget for a skill description, matching Smithy's skill budget. */
const SKILL_DESCRIPTION_WORDS = 55;

/** The two agents an instruction file may opt out of. */
const EXCLUDABLE_AGENTS = new Set(["code-review", "coding-agent"]);

/**
 * References that resolve only inside March. A file in the Smithy-general
 * layer is written to be true in any repository that uses Smithy, so it may
 * name none of them.
 */
const REPO_SPECIFIC_REFERENCES = [
  { label: "a March source path", pattern: /(^|[\s`(])src\// },
  { label: "a March docs path", pattern: /(^|[\s`(])docs\/(subsystems|vision|operating-philosophy|open-core-boundary|testing-strategy|Observability)/ },
  { label: "a March subsystem", pattern: /\b(Hatchery|Brood|Herald|Legate|Castra|Statio|Steward|Tessera)\b/ },
  { label: "an issue or pull request number", pattern: /(^|\s)#\d+\b/ },
  { label: "the repository name", pattern: /\bMarch\b/ },
];

/** Split a leading `---` YAML block from the body. */
function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) return { frontmatter: "", body: content };
  return { frontmatter: match[1], body: content.slice(match[0].length) };
}

function frontmatterValue(frontmatter, key) {
  const match = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim().replace(/^["']|["']$/g, "");
}

/** Problems with one `.github/instructions/*.instructions.md` file. */
function checkInstructionFile(fileName, content) {
  const problems = [];
  const { frontmatter } = splitFrontmatter(content);
  if (!frontmatterValue(frontmatter, "applyTo")) {
    problems.push(`${fileName}: no applyTo — reviewers ignore an instruction file without one`);
  }
  const excluded = frontmatterValue(frontmatter, "excludeAgent");
  if (excluded !== undefined && !EXCLUDABLE_AGENTS.has(excluded)) {
    problems.push(`${fileName}: excludeAgent "${excluded}" is not one of ${[...EXCLUDABLE_AGENTS].join(", ")}`);
  }
  if (content.length > INSTRUCTION_CHAR_BUDGET) {
    problems.push(`${fileName}: ${content.length} characters, over the ${INSTRUCTION_CHAR_BUDGET} budget — move depth into a skill`);
  }
  return problems;
}

/** Problems with one `.github/skills/<dir>/SKILL.md` file. */
function checkSkill(dirName, content) {
  const problems = [];
  const { frontmatter } = splitFrontmatter(content);
  const name = frontmatterValue(frontmatter, "name");
  if (name !== dirName) {
    problems.push(`${dirName}: frontmatter name "${name ?? ""}" does not match its directory`);
  }
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(dirName)) {
    problems.push(`${dirName}: skill names use lowercase letters, digits, and hyphens only`);
  }
  const description = frontmatterValue(frontmatter, "description") ?? "";
  const words = description.split(/\s+/).filter(Boolean).length;
  if (words === 0) {
    problems.push(`${dirName}: no description — it is the trigger a reviewer matches on`);
  } else if (words > SKILL_DESCRIPTION_WORDS) {
    problems.push(`${dirName}: description is ${words} words, over the ${SKILL_DESCRIPTION_WORDS}-word skill budget`);
  }
  return problems;
}

/** Repository-specific references found in a Smithy-general file. */
function findRepoSpecificReferences(label, content) {
  const { body } = splitFrontmatter(content);
  return REPO_SPECIFIC_REFERENCES.filter(({ pattern }) => pattern.test(body)).map(
    ({ label: what }) => `${label}: names ${what}, which only exists in this repository`,
  );
}

/** Skill names an instruction file sends the reviewer to, as `` `name` skill ``. */
function referencedSkills(content) {
  return [...content.matchAll(/`([a-z0-9]+(?:-[a-z0-9]+)*)`\s+skill\b/g)].map((m) => m[1]);
}

/**
 * The `files` → `applyTo` pairs under `knowledge_base.code_guidelines` in
 * `.coderabbit.yaml`. The file keeps one shape (`- files: "…"` followed by
 * `applyTo: "…"`), so the pairs are read by line, not with a YAML parser.
 */
function codeRabbitGuidelineMap(yaml) {
  return [...yaml.matchAll(/^\s*- files:\s*"([^"]+)"\s*\r?\n\s*applyTo:\s*"([^"]*)"\s*$/gm)].map(
    ([, files, applyTo]) => ({ files, applyTo }),
  );
}

/**
 * Problems with the CodeRabbit path map, given the rule files it should
 * cover. `instructions` and `skills` map a file or directory name to its
 * content.
 */
function checkCodeRabbitConfig(yaml, instructions, skills) {
  const problems = [];
  const config = yaml.replace(/^\s*#.*$/gm, "");
  const entries = codeRabbitGuidelineMap(config);
  const mapped = new Map(entries.map(({ files, applyTo }) => [files, applyTo]));
  if ((config.match(/^\s*- files:/gm) ?? []).length !== entries.length) {
    problems.push('.coderabbit.yaml: an entry is not `- files: "…"` followed by `applyTo: "…"`');
  }
  if (mapped.size !== entries.length) {
    problems.push(".coderabbit.yaml: a rule file is mapped twice");
  }
  if (/^\s*(path_instructions|instructions|tone_instructions):/m.test(config)) {
    problems.push(".coderabbit.yaml: holds inline instruction text — put the rule in a rule file and map it");
  }

  const expected = new Map();
  const skillScopes = new Map();
  for (const [fileName, content] of Object.entries(instructions)) {
    const { frontmatter } = splitFrontmatter(content);
    // A file that opts out of code review is not a reviewer rule.
    if (frontmatterValue(frontmatter, "excludeAgent") === "code-review") continue;
    const applyTo = frontmatterValue(frontmatter, "applyTo");
    expected.set(`.github/instructions/${fileName}`, applyTo);
    for (const skill of referencedSkills(content)) {
      skillScopes.set(skill, [...(skillScopes.get(skill) ?? []), applyTo]);
    }
  }
  for (const dirName of Object.keys(skills)) {
    const scopes = skillScopes.get(dirName) ?? [];
    if (scopes.length !== 1) {
      problems.push(`${dirName}: ${scopes.length} instruction files send the reviewer to this skill — CodeRabbit needs exactly one to take its paths from`);
      continue;
    }
    expected.set(`.github/skills/${dirName}/SKILL.md`, scopes[0]);
  }

  for (const [files, applyTo] of expected) {
    if (!mapped.has(files)) {
      problems.push(`.coderabbit.yaml: no entry for ${files} — CodeRabbit will not apply it`);
    } else if (mapped.get(files) !== applyTo) {
      problems.push(`.coderabbit.yaml: ${files} is mapped to "${mapped.get(files)}", but its rule file says "${applyTo}"`);
    }
  }
  for (const files of mapped.keys()) {
    if (!expected.has(files)) {
      problems.push(`.coderabbit.yaml: ${files} is not a reviewer rule file in this repository`);
    }
  }
  return problems;
}

const instructionFiles = fs.existsSync(instructionsDir)
  ? fs.readdirSync(instructionsDir).filter((f) => f.endsWith(".md")).sort()
  : [];
const skillDirs = fs.existsSync(skillsDir)
  ? fs.readdirSync(skillsDir).filter((d) => fs.existsSync(path.join(skillsDir, d, "SKILL.md"))).sort()
  : [];
const readInstruction = (f) => fs.readFileSync(path.join(instructionsDir, f), "utf8");
const readSkill = (d) => fs.readFileSync(path.join(skillsDir, d, "SKILL.md"), "utf8");

describe("reviewer instructions — path-scoped files", () => {
  it("ships at least the Smithy-general and repository layers", () => {
    expect(instructionFiles.some((f) => f.startsWith("smithy."))).toBe(true);
    expect(instructionFiles.some((f) => !f.startsWith("smithy."))).toBe(true);
  });

  it("names every file NAME.instructions.md", () => {
    expect(instructionFiles.filter((f) => !f.endsWith(".instructions.md"))).toEqual([]);
  });

  it("gives every file an applyTo, a valid excludeAgent, and a size inside the budget", () => {
    expect(instructionFiles.flatMap((f) => checkInstructionFile(f, readInstruction(f)))).toEqual([]);
  });

  it("keeps the repository-wide file inside the same budget", () => {
    const content = fs.readFileSync(path.join(githubDir, "copilot-instructions.md"), "utf8");
    expect(content.length).toBeLessThanOrEqual(INSTRUCTION_CHAR_BUDGET);
  });

  it("detects a planted file with no applyTo", () => {
    expect(checkInstructionFile("plant.instructions.md", '---\nexcludeAgent: "coding-agent"\n---\nbody')).toHaveLength(1);
  });

  it("detects a planted unknown excludeAgent", () => {
    const plant = '---\napplyTo: "**"\nexcludeAgent: "reviewer"\n---\nbody';
    expect(checkInstructionFile("plant.instructions.md", plant)).toHaveLength(1);
  });

  it("detects a planted over-budget file", () => {
    const plant = `---\napplyTo: "**"\n---\n${"x".repeat(INSTRUCTION_CHAR_BUDGET)}`;
    expect(checkInstructionFile("plant.instructions.md", plant)).toHaveLength(1);
  });
});

describe("reviewer instructions — skills", () => {
  it("gives every skill a matching name and a description inside the skill budget", () => {
    expect(skillDirs.flatMap((d) => checkSkill(d, readSkill(d)))).toEqual([]);
  });

  it("sends the reviewer only to skills that exist", () => {
    const sources = [
      ...instructionFiles.map((f) => [f, readInstruction(f)]),
      ["AGENTS.md", fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8")],
    ];
    const dead = sources.flatMap(([label, content]) =>
      referencedSkills(content)
        .filter((name) => !skillDirs.includes(name))
        .map((name) => `${label} → ${name}`),
    );
    expect(dead).toEqual([]);
  });

  it("detects a planted name that does not match its directory", () => {
    expect(checkSkill("review-plant", '---\nname: other\ndescription: "Use when reviewing."\n---\n')).toHaveLength(1);
  });

  it("detects a planted over-budget description", () => {
    const description = Array.from({ length: SKILL_DESCRIPTION_WORDS + 1 }, () => "word").join(" ");
    expect(checkSkill("review-plant", `---\nname: review-plant\ndescription: "${description}"\n---\n`)).toHaveLength(1);
  });

  it("detects a planted reference to a skill that does not exist", () => {
    expect(referencedSkills("use the `no-such-review` skill")).toEqual(["no-such-review"]);
  });
});

describe("reviewer instructions — the Smithy-general layer stays general", () => {
  it("names nothing that exists only in this repository", () => {
    const leaks = [
      ...instructionFiles
        .filter((f) => f.startsWith("smithy."))
        .flatMap((f) => findRepoSpecificReferences(f, readInstruction(f))),
      ...skillDirs
        .filter((d) => d.startsWith("smithy-"))
        .flatMap((d) => findRepoSpecificReferences(d, readSkill(d))),
    ];
    expect(leaks).toEqual([]);
  });

  it("detects planted repository-specific references", () => {
    const plant = "---\napplyTo: \"**\"\n---\nRead `src/brood/service/teardown.ts`, ask Herald, and see #155.";
    expect(findRepoSpecificReferences("plant", plant)).toHaveLength(3);
  });

  it("leaves artifact vocabulary alone", () => {
    const clean =
      "---\napplyTo: \"**\"\n---\nAn open `SD-003` row, `AS 2.1`, `FR-006`, a `forge` or `mark` pull request, and `.claude/commands/smithy.audit.md`.";
    expect(findRepoSpecificReferences("clean", clean)).toEqual([]);
  });
});

describe("reviewer instructions — AGENTS.md", () => {
  it("keeps the section Codex reads its review rules from", () => {
    const agents = fs.readFileSync(path.join(repoRoot, "AGENTS.md"), "utf8");
    expect(agents).toMatch(/^## Code Review Rules$/m);
  });
});

describe("reviewer instructions — the CodeRabbit path map", () => {
  const yaml = fs.readFileSync(path.join(repoRoot, ".coderabbit.yaml"), "utf8");
  const instructions = Object.fromEntries(instructionFiles.map((f) => [f, readInstruction(f)]));
  const skills = Object.fromEntries(skillDirs.map((d) => [d, readSkill(d)]));

  const plantInstructions = {
    "runtime.instructions.md": '---\napplyTo: "src/**"\nexcludeAgent: "coding-agent"\n---\nLoad the `review-plant` skill.',
    "agent-only.instructions.md": '---\napplyTo: "**"\nexcludeAgent: "code-review"\n---\nbody',
  };
  const plantSkills = { "review-plant": "---\nname: review-plant\n---\n" };
  const plantYaml = (entries) =>
    `knowledge_base:\n  code_guidelines:\n    filePatterns:\n${entries
      .map(([files, applyTo]) => `      - files: "${files}"\n        applyTo: "${applyTo}"\n`)
      .join("")}`;
  const cleanEntries = [
    [".github/instructions/runtime.instructions.md", "src/**"],
    [".github/skills/review-plant/SKILL.md", "src/**"],
  ];

  it("maps every review rule file and skill to the paths its own applyTo names", () => {
    expect(checkCodeRabbitConfig(yaml, instructions, skills)).toEqual([]);
  });

  it("lets unset keys fall through to the CodeRabbit app settings", () => {
    expect(yaml).toMatch(/^inheritance: true$/m);
  });

  it("accepts a clean planted map, leaving out a file that opts out of code review", () => {
    expect(checkCodeRabbitConfig(plantYaml(cleanEntries), plantInstructions, plantSkills)).toEqual([]);
  });

  it("detects a planted rule file with no entry", () => {
    expect(checkCodeRabbitConfig(plantYaml(cleanEntries.slice(1)), plantInstructions, plantSkills)).toHaveLength(1);
  });

  it("detects a planted applyTo that drifted from its rule file", () => {
    const drifted = [[cleanEntries[0][0], "src/**/*.ts"], cleanEntries[1]];
    expect(checkCodeRabbitConfig(plantYaml(drifted), plantInstructions, plantSkills)).toHaveLength(1);
  });

  it("detects a planted entry for a file that is not a rule file", () => {
    const extra = [...cleanEntries, ["docs/vision.md", "**"]];
    expect(checkCodeRabbitConfig(plantYaml(extra), plantInstructions, plantSkills)).toHaveLength(1);
  });

  it("detects a planted skill no instruction file sends the reviewer to", () => {
    const orphan = { ...plantSkills, "review-orphan": "---\nname: review-orphan\n---\n" };
    expect(checkCodeRabbitConfig(plantYaml(cleanEntries), plantInstructions, orphan)).toHaveLength(1);
  });

  it("detects planted inline instruction text", () => {
    const inline = `reviews:\n  path_instructions:\n    - path: "src/**"\n${plantYaml(cleanEntries)}`;
    expect(checkCodeRabbitConfig(inline, plantInstructions, plantSkills)).toHaveLength(1);
  });
});
