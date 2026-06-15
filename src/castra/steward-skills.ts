import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveHeraldUrl } from "../herald/service/client.js";

/**
 * Steward skill + hook provisioning.
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
 *
 * Steward self-report (#371): the same root also carries the `Notification` +
 * `Stop` hook (`hooks/steward-report.mjs`) and a generated `settings.json` that
 * wires it. The settings file is loaded via `claude --settings` (see
 * `buildLaunchArgs`); on each turn boundary the hook reads the steward's last
 * message, classifies it (awaiting_input / reported / working), and POSTs a
 * report to Herald so the legate can escalate a steward parked on a human. The
 * hook needs the slice id / profile / Herald URL to tag its report — Castra
 * writes them per-session into `<root>/sessions/<worktree-dir>.json` at launch
 * (see {@link recordStewardSession}), keyed by the worktree the hook runs in.
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

/** Absolute path of the generated steward `settings.json` (loaded via `claude
 *  --settings`). It wires the steward self-report Notification/Stop hook. */
export function stewardSettingsPath(): string {
  return path.join(stewardSkillsRoot(), "settings.json");
}

/** Directory holding the per-session launch sidecars the report hook reads. */
export function stewardSessionsDir(): string {
  return path.join(stewardSkillsRoot(), "sessions");
}

/**
 * Per-session sidecar path, keyed by the steward's worktree directory name —
 * the same key the hook derives from its `cwd`. The hook runs inside the
 * worktree, so `basename(worktreePath)` is the one identifier both sides share
 * without any env-var propagation through agent-deck/tmux.
 */
export function stewardSessionFilePath(worktreePath: string): string {
  return path.join(stewardSessionsDir(), `${path.basename(worktreePath)}.json`);
}

/**
 * The steward `settings.json` content: a `Notification` + `Stop` hook, each
 * invoking the shipped `steward-report.mjs` by absolute path. Pure + exported
 * so the wiring is unit-testable without touching the filesystem.
 */
export function buildStewardSettings(root: string): {
  hooks: Record<string, Array<{ hooks: Array<{ type: string; command: string }> }>>;
} {
  const script = path.join(root, "hooks", "steward-report.mjs");
  // Quote the path so a root containing spaces survives the shell the hook
  // executor uses. Single-quote is safe — March-owned paths never contain one.
  const entry = [{ hooks: [{ type: "command", command: `node '${script}'` }] }];
  return { hooks: { Notification: entry, Stop: entry } };
}

/**
 * Record the launch-time context the report hook echoes back: profile, slice
 * id, and the Herald URL to POST to. Best-effort and synchronous (the launch
 * path is sync) — a write failure must never break a launch. A no-op without a
 * slice id (nothing to tag) or worktree path (no key).
 */
export function recordStewardSession(input: {
  readonly worktreePath: string;
  readonly profile: string;
  readonly sliceId?: string;
  /** Defaults to {@link resolveHeraldUrl} (the deterministic localhost port). */
  readonly heraldUrl?: string;
}): void {
  if (!input.worktreePath || !input.sliceId) return;
  try {
    fsSync.mkdirSync(stewardSessionsDir(), { recursive: true });
    const payload = {
      profile: input.profile,
      sliceId: input.sliceId,
      heraldUrl: input.heraldUrl ?? resolveHeraldUrl(process.env),
    };
    fsSync.writeFileSync(
      stewardSessionFilePath(input.worktreePath),
      JSON.stringify(payload),
      "utf-8",
    );
  } catch {
    // Best-effort — see doc comment.
  }
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
 * skills/`, the self-report hook into `<root>/hooks/`, and the generated
 * `settings.json` that wires it — so a session launched with `--add-dir
 * <root>` (skills) and `--settings <root>/settings.json` (hook) finds them.
 * Idempotent and overwriting — the template is the source of truth, so a re-run
 * refreshes any edited skill/hook. Returns the root that was provisioned.
 */
export async function ensureStewardSkills(): Promise<string> {
  const root = stewardSkillsRoot();
  const templateDir = await findStewardTemplateDir();
  // Wipe-then-copy so a skill/hook deleted/renamed in the shipped template does
  // not linger — `fs.cp` overwrites but never prunes. The destination is
  // March-owned (~/.march/steward), so the wipe is safe.
  const skillsDest = path.join(root, ".claude", "skills");
  await fs.rm(skillsDest, { recursive: true, force: true });
  await fs.mkdir(skillsDest, { recursive: true });
  await fs.cp(path.join(templateDir, "skills"), skillsDest, { recursive: true, force: true });

  // Steward self-report hook (#371) + the settings.json that loads it.
  const hooksDest = path.join(root, "hooks");
  await fs.rm(hooksDest, { recursive: true, force: true });
  await fs.mkdir(hooksDest, { recursive: true });
  await fs.cp(path.join(templateDir, "hooks"), hooksDest, { recursive: true, force: true });
  await fs.writeFile(
    stewardSettingsPath(),
    JSON.stringify(buildStewardSettings(root), null, 2) + "\n",
    "utf-8",
  );
  return root;
}
