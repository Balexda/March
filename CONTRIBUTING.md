# Contributing to March CLI

## Development Setup

```bash
npm install
npm run build        # Build with tsup
npm run typecheck    # Type-check without emitting
npm test             # Run all tests
```

Always use `npm run` scripts. Do not use `npx tsx`, `npx vitest`, or similar direct invocations.

## Source Layout

March's source is organized by product subsystem rather than by generic layers:

| Directory | Ownership |
|-----------|-----------|
| `src/cli.ts` | Executable bin entrypoint only; delegates to `src/cli/program.ts`. |
| `src/cli/` | Commander program setup and command dispatch. |
| `src/bootstrap/` | `march init` / `march update`, manifest handling, and deployed base skills. |
| `src/spawn/` | Spawn execution pipeline: snapshots, image builds, backend entrypoints, and container launch. |
| `src/hatchery/` | Container/profile policy. Today this owns the hardcoded spawn config; future Hatchery profiles expand here. |
| `src/brood/` | Spawn lifecycle state: worktrees, branches, records, and cleanup ownership. |
| `src/herald/` | Deterministic event bus code. Add mini-herald event/log/daemon modules here when that feature lands. |
| `src/legate/` | Legate conductor setup, template rendering, bridge checks, and related orchestration bootstrap. |
| `src/shared/` | Small cross-cutting primitives with no March-domain ownership, such as dependency checks, exit codes, and version lookup. |
| `src/templates/legate/` | Static Legate runtime template assets packaged with the CLI. Keep these separate from Legate TypeScript implementation. |

Tests live next to the modules they cover. When adding a module, place it under the subsystem that should own the behavior long-term, not necessarily the milestone that first needs it.

## Testing

March has two testing tiers:

### Tier 1: CLI Behavior (init / update / spawn dispatch)

Tests that the CLI parses options correctly, deploys files to the right locations, handles idempotency, and rolls back partial state on failure. Covered by automated tests and human interactive tests.

**Automated** (`npm test`) — runs in CI on every push and PR:

| Test file | Scope |
|-----------|-------|
| `src/cli/program.test.ts` | CLI integration (init, update, spawn dispatch wiring) |
| `src/bootstrap/init.test.ts` | `march init`: manifest creation, skill deployment, idempotency guard |
| `src/bootstrap/update.test.ts` | `march update`: upgrade/downgrade gating, `--yes` force path |
| `src/legate/init.test.ts` | `march legate init`: slug derivation, template render, idempotent re-runs |
| `src/bootstrap/manifest.test.ts` | Manifest schema and validity checks |
| `src/bootstrap/skills.test.ts` | M1 skill definitions and deployment targets |
| `src/shared/deps.test.ts` | PATH lookup, finder availability, dependency warnings |
| `src/brood/worktree.test.ts` | Spawn worktree creation + rollback |
| `src/spawn/snapshot.test.ts` | Snapshot Exclusion List, build-context assembly |
| `src/spawn/snapshot-build.test.ts` | Spawn Dockerfile generation, image build, image removal |
| `src/brood/spawn-record.test.ts` | SpawnRecord write / state transitions / rollback |

**Human tests** (interactive terminal) — for the `readline`-based downgrade prompt that only fires when stdin is a TTY. See **[tests/Manual.tests.md](tests/Manual.tests.md)** (H1-H2).

### Tier 2: End-to-End Spawn Dispatch

Tests that `march spawn dispatch` produces a real worktree, builds a tagged Docker image, writes a `SpawnRecord` in `~/.march/spawns/`, and rolls back cleanly on failure. Requires `git` and `docker` on `PATH` and a pullable base image, so it runs as an agent test rather than in CI.

**Agent tests** (Claude Code session) — verify the full dispatch lifecycle on a throwaway repo and the `failed`-state rollback. See **[tests/Agent.tests.md](tests/Agent.tests.md)** (A1-A5).

## Automated Dependency Updates

This repo runs Dependabot on a monthly schedule (plus immediate security advisories) and pings GitHub Copilot Coding Agent to fix CI failures on Dependabot PRs. See **[docs/automated-dependency-updates.md](docs/automated-dependency-updates.md)** for the day-to-day flow and the one-time repo settings required.

## Pre-Release Checklist

Before publishing a new version:

1. All automated tests pass: `npm test`
2. Agent tests (A1-A5) verified in a Claude Code session
3. Human tests (H1-H2) verified in an interactive terminal
4. Trigger the **Publish to npm** workflow with both test gate checkboxes checked
