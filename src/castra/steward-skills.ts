import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Steward skill provisioning.
 *
 * Steward (the Hatchery "manager") sessions open every automated PR. We want
 * them to follow a single, versioned PR convention regardless of which target
 * repo they check out, so we ship `steward-*` skills (currently just
 * `steward-pr`) and load them into each session via Claude Code's `--add-dir`
 * (forwarded through agent-deck's `--extra-arg`; see `buildLaunchArgs`).
 *
 * `--add-dir <root>` loads `<root>/.claude/skills/**` WITHOUT relocating the
 * host `~/.claude` config, so the steward keeps the operator's credentials and
 * just gains the steward skills on top. The directory must exist before the
 * session launches, so {@link ensureStewardSkills} runs at Castra serve startup.
 */

const REL_SKILL_MARKER = path.join("skills", "steward-pr", "SKILL.md");

/**
 * The shared directory `--add-dir` points at. Claude Code reads
 * `<root>/.claude/skills/**` from it. Override with `MARCH_STEWARD_SKILLS_DIR`
 * (e.g. in tests); defaults to `~/.march/steward`, mirroring the other
 * `~/.march/<service>` data dirs. The path is consumed by the `claude` process
 * running on the host tmux server; Castra's HOME is bind-mounted at the
 * identical absolute path, so `os.homedir()` resolves the same in-container.
 */
export function stewardSkillsRoot(): string {
  const override = process.env.MARCH_STEWARD_SKILLS_DIR?.trim();
  if (override) return override;
  return path.join(os.homedir(), ".march", "steward");
}

/**
 * Locate the bundled steward template directory (the one that contains
 * `skills/steward-pr/SKILL.md`). Tries paths relative to this module so it
 * resolves both from source (`src/castra/steward-skills.ts` → `src/templates/
 * steward`) and when bundled (`dist/cli.js` → `../src/templates/steward`, since
 * `package.json#files` ships `src/templates`). Mirrors `findTemplateDir` in
 * `src/legate/init.ts`.
 */
async function findStewardTemplateDir(): Promise<string> {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(here, "templates", "steward"),
    path.join(here, "..", "templates", "steward"),
    path.join(here, "..", "src", "templates", "steward"),
    path.join(here, "..", "..", "src", "templates", "steward"),
    path.join(here, "..", "..", "..", "src", "templates", "steward"),
  ];
  for (const c of candidates) {
    try {
      await fs.access(path.join(c, REL_SKILL_MARKER));
      return c;
    } catch {
      // try next
    }
  }
  throw new Error(
    `Cannot locate steward template dir. Searched:\n  ${candidates.join("\n  ")}`,
  );
}

/**
 * Materialize the shipped steward skills into `<stewardSkillsRoot>/.claude/
 * skills/` so a session launched with `--add-dir <stewardSkillsRoot>` finds
 * them. Idempotent and overwriting — the template is the source of truth, so a
 * re-run refreshes any edited skill. Returns the root that was provisioned.
 */
export async function ensureStewardSkills(): Promise<string> {
  const root = stewardSkillsRoot();
  const templateDir = await findStewardTemplateDir();
  const skillsSrc = path.join(templateDir, "skills");
  const skillsDest = path.join(root, ".claude", "skills");
  // Wipe-then-copy so a skill deleted/renamed in the shipped template does not
  // linger as a stale steward skill — `fs.cp` overwrites but never prunes. The
  // destination is March-owned (~/.march/steward), so the wipe is safe.
  await fs.rm(skillsDest, { recursive: true, force: true });
  await fs.mkdir(skillsDest, { recursive: true });
  await fs.cp(skillsSrc, skillsDest, { recursive: true, force: true });
  return root;
}
