---
applyTo: "src/templates/**,.claude/skills/march.*/**,scripts/generate-skills.mjs"
excludeAgent: "coding-agent"
---
# Reviewing March's deployed templates

`src/templates/` holds prompts and skills that March renders into running
sessions, not documentation for this repository:

| Tree | Reaches |
|------|---------|
| `src/templates/legate/` | the Legate conductor, rendered by `src/legate/init.ts` |
| `src/templates/steward/` | each steward session's worktree |
| `src/templates/skills/` | the `march.*` skills, generated per execution context |

## Check

- **Generated skills are committed and current.** `npm run build` renders
  `src/templates/skills/` into `.claude/skills/march.*` (committed) and a
  container variant under `dist/` (ignored). A source change with no matching
  change to the committed variant, or a hand edit to the committed variant
  with no source change, is a finding.
- **Addressing is baked per context.** Service URLs and the `march`
  invocation come from the generator's context variables. Runtime "am I in a
  container?" detection in a shipped script is a finding.
- **Templates are read by an agent with no repository context.** An
  instruction to open a March source file, issue, or doc that does not exist
  in the session's working directory will fail there.
- **Renamed or removed skills disappear.** Steward provisioning replaces
  the March-owned skills directory, so a stale copy cannot linger.
- **Scripts fail loudly.** A skill script that exits 0 after a failed call,
  or prints non-JSON on a JSON contract, hides the failure from the agent.

`README.md`, `CONTRIBUTING.md`, and `CLAUDE.md` under `src/templates/legate/`
are developer documentation and are not deployed. `CLAUDE.prompt` is.

## Do not ask for

- Skill allowlists in a steward's settings. Steward sessions run with
  `--permission-mode auto`.
