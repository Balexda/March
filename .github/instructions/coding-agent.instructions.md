---
applyTo: "**"
excludeAgent: "code-review"
---
# Working in this repository as the Copilot coding agent

## Before opening or readying a pull request

1. Run the validation commands from the repository root:
   ```bash
   npm run typecheck
   npm run build
   npm test
   ```
2. If any command fails, stop, repair the failure, and run all three again.
   Do not proceed until they pass.
3. Open the pull request as a **Draft**. Remove "Draft" only when validation
   passes locally and in CI.

Use the `npm` scripts. Do not call `npx vitest`, `npx tsup`, or ad hoc
equivalents. Git-heavy tests create temporary repositories and linked
worktrees, so they may need permissions outside a default sandbox.

## Where code goes

`AGENTS.md` maps each directory under `src/` to the subsystem that owns it.
Split a feature that spans subsystems by ownership. Do not put runtime code
directly under `src/`; `src/cli.ts` only imports `runCli`.

## What moves with a change

- A new `*.test.ts` or `*.test.mjs` file starts with its tag block
  (`@l0`–`@l3`, `@deterministic`/`@stochastic`, `@ci`/`@scheduled`). See
  `CONTRIBUTING.md#test-file-tag-blocks`.
- A change to a subsystem's public surface updates
  `docs/subsystems/<name>/contract.md` in the same pull request.
- A new dispatch path or failure mode emits a span; see
  `docs/Observability.md`.
- Edits under `src/templates/skills/` are followed by `npm run build`, which
  regenerates the committed `.claude/skills/march.*` variants.
- Do not edit `.claude/commands/`, `.claude/agents/`, `.claude/prompts/`,
  `.claude/skills/smithy*`, `.agents/`, `.codex/`, `tools/codex/`, or
  `.smithy/smithy-manifest.json`: they are a Smithy snapshot refreshed by the
  `Smithy upgrade` workflow.
- Keep `dist/` out of commits.

## Pull request etiquette

- Fill in the description with what actually happened, and link the issue
  with `Fixes #<number>`.
- When applying follow-up feedback, add commits. Do not amend and force-push;
  incremental commits preserve the review history.
