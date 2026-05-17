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

The full framing — scope tiers (L0 unit / L1 subsystem / L2 cross-subsystem / L3 system), the deterministic-vs-stochastic axis, the cassette pivot, and the cost policy — lives in **[docs/testing-strategy.md](docs/testing-strategy.md)**. Read it once before adding tests in a new layer.

Day-to-day commands:

- **`npm test`** — runs the deterministic CI suite. Today that's the full vitest set: L0, L1, and the L2 cases that exercise real Docker (`spawn/container-launch`, `spawn/snapshot-build`, `hatchery/legate-container`). Cassette-replayed L2/L3 will land here as the [Roadmap](docs/testing-strategy.md#9-roadmap) progresses. Cost: $0, < 2 minutes. Runs on every push and PR.
- **`npm run typecheck`** — `tsc --noEmit`.

Agent-driven and human tests:

- **Agent tests** (Claude Code session) — end-to-end dispatch lifecycle on a throwaway repo and `failed`-state rollback. Today documented as prose; aspirational target is `L3 / Deterministic / CI` (cassette-replayed) plus `L3 / Stochastic / Scheduled` (weekly live-backend). See **[tests/Agent.tests.md](tests/Agent.tests.md)** (A1–A5).
- **Human tests** (interactive terminal) — TTY-only flows like the `readline` downgrade prompt. See **[tests/Manual.tests.md](tests/Manual.tests.md)** (H1–H2).

## Automated Dependency Updates

This repo runs Dependabot on a monthly schedule (plus immediate security advisories) and pings GitHub Copilot Coding Agent to fix CI failures on Dependabot PRs. See **[docs/automated-dependency-updates.md](docs/automated-dependency-updates.md)** for the day-to-day flow and the one-time repo settings required.

## Pre-Release Checklist

Before publishing a new version:

1. All automated tests pass: `npm test`
2. Agent tests (A1–A5) verified in a Claude Code session
3. Human tests (H1–H2) verified in an interactive terminal
4. Trigger the **Publish to npm** workflow with both test gate checkboxes checked

See **[docs/testing-strategy.md § Cost policy](docs/testing-strategy.md#6-cost-policy)** for how scheduled stochastic runs and cassette refresh interact with the release flow once Phase 2+ of the Roadmap lands.
