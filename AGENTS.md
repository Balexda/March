# Agent Guide

This repo is the March CLI. Keep changes aligned with the product subsystem boundaries; do not put new runtime code directly under `src/` unless it is the executable entrypoint.

## Source Ownership

- `src/cli.ts`: bin wrapper only. It should import `runCli` and do no command work itself.
- `src/cli/`: Commander setup and command dispatch. Keep command handlers thin; move subsystem behavior into the owning domain directory.
- `src/bootstrap/`: install/update/manifest/skill deployment for `march init` and `march update`.
- `src/spawn/`: one-shot spawn execution: snapshot, Dockerfile/image build, backend entrypoint, container launch, prompt handoff, output extraction.
- `src/hatchery/`: container/profile policy. The current hardcoded spawn config lives here because Hatchery will own declarative profiles.
- `src/brood/`: lifecycle state and cleanup: spawn records, worktrees, branches, running/stopped session tracking.
- `src/herald/`: deterministic event bus and mini-herald modules. PR event schema, snapshots, event log, cursor handling, and daemon code belong here.
- `src/legate/`: Legate conductor setup and orchestration bootstrap. Static deployed assets stay in `src/templates/legate/`.
- `src/shared/`: small infrastructure utilities with no durable domain owner.

When a feature spans multiple subsystems, split code by ownership. For example, a future dispatch option may add CLI parsing in `src/cli/`, profile resolution in `src/hatchery/`, lifecycle updates in `src/brood/`, and execution changes in `src/spawn/`.

## Working Rules

- Prefer behavior-preserving moves before behavior changes. Move tests with their modules.
- Keep `src/templates/legate/` packaged as static assets; do not merge template files into `src/legate/`.
- Preserve the public CLI contract unless the task explicitly changes it.
- Keep generated `dist/` out of commits unless the release process asks for it.
- Use `npm run` scripts for verification. Do not invoke `npx vitest`, `npx tsup`, or ad hoc equivalents.
- Be aware that git-heavy tests may need permissions outside the default sandbox because they create temporary repositories and linked worktrees.

## Verification

Run these after structural or runtime changes:

```bash
npm run typecheck
npm run build
npm test
```

For CLI-entrypoint changes, also spot-check:

```bash
node dist/cli.js version
node dist/cli.js help
node dist/cli.js spawn
node dist/cli.js legate init --help
```
