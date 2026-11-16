# March — Copilot instructions

March is a CLI and a set of containerized services that execute Smithy plans
with minimum operator intervention: Hatchery spawns sandboxed sessions, Brood
owns lifecycle and teardown, Herald records an event-sourced log of system
state, a single Legate drives every registered profile, and Castra hosts the
interactive steward sessions. `AGENTS.md` maps each subsystem to its
directory; `docs/vision.md` and `docs/operating-philosophy.md` say why it is
shaped this way.

## Four kinds of file

| Kind | Where | What it is |
|------|-------|------------|
| Runtime source | `src/`, `scripts/`, `docker/` | TypeScript bundled by tsup to `dist/cli.js`, plus each service's image and compose file. |
| Deployed templates | `src/templates/` | Prompts and skills March renders into Legate, steward, and spawn sessions. The `march.*` skills are generated into the committed `.claude/skills/march.*`. |
| Smithy snapshot | `.claude/commands/`, `.claude/agents/`, `.claude/prompts/`, `.claude/skills/smithy*`, `.agents/`, `.codex/`, `tools/codex/`, `.smithy/smithy-manifest.json` | Output of `smithy update`, refreshed by the `Smithy upgrade` workflow. |
| Plans and contracts | `specs/`, `docs/rfcs/`, `docs/subsystems/` | Smithy planning artifacts, and each subsystem's `contract.md`. |

## Validating a change

```bash
npm run typecheck
npm run build
npm test
```

Use the `npm` scripts. Do not call `npx vitest` or `npx tsup` directly.

## Where the detailed guidance lives

- `.github/instructions/*.instructions.md`: path-scoped rules, loaded for the
  files a change touches.
- `.github/skills/*/SKILL.md`: deeper review procedures, loaded on demand.
- `docs/reviewer-instructions.md`: how those files are organised and how a
  rule gets added.

Files named `smithy.*` or `smithy-*` there describe how Smithy artifacts work
in any repository. Everything else is specific to March.
