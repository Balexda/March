/**
 * MarchSkill represents a single skill or prompt file deployed
 * from a source template to an agent-specific location.
 *
 * Skills are markdown instruction documents consumed by AI agents,
 * not executable code.
 */
export interface MarchSkill {
  /** The deployed filename, prefixed with `march.` (e.g., `march.spawn-dispatch.md`). */
  filename: string;

  /** The skill category (e.g., `spawn-dispatch`, `spawn-status`, `output-handling`). */
  category: string;

  /**
   * The agent-specific subdirectory path suffix where this file is placed
   * (e.g., `.claude/commands` or `.claude/prompts`).
   * Stored as a relative path — deployment code joins with the home directory.
   */
  deployTarget: string;

  /** The target agent backend (e.g., `"claude"`). */
  agent: string;

  /** The placeholder markdown content for this skill file. */
  content: string;
}

/**
 * Returns the M1 (Milestone 1) skill definitions.
 *
 * These are placeholder skill files that establish the file slots
 * and deployment mechanism. Real content will be authored during
 * Features 2-6 implementation.
 */
export function getM1Skills(): MarchSkill[] {
  return [
    {
      filename: "march.spawn-dispatch.md",
      category: "spawn-dispatch",
      deployTarget: ".claude/commands",
      agent: "claude",
      content: [
        "# March: Spawn Dispatch",
        "",
        "This is a placeholder skill file that will be authored during Features 2-6 implementation.",
        "",
      ].join("\n"),
    },
    {
      filename: "march.spawn-status.md",
      category: "spawn-status",
      deployTarget: ".claude/commands",
      agent: "claude",
      content: [
        "# March: Spawn Status",
        "",
        "This is a placeholder skill file that will be authored during Features 2-6 implementation.",
        "",
      ].join("\n"),
    },
    {
      filename: "march.output-handling.md",
      category: "output-handling",
      deployTarget: ".claude/prompts",
      agent: "claude",
      content: [
        "# March: Output Handling",
        "",
        "This is a placeholder skill file that will be authored during Features 2-6 implementation.",
        "",
      ].join("\n"),
    },
  ];
}
