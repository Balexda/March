# March

CLI for the **March** agentic-development workflow. March deploys a small set of Claude Code skills, then takes a worktree of your repo, snapshots it into a Docker image, and dispatches a sandboxed *spawn* for an agent to work inside.

## Install

```bash
npm install -g @balexda/march
```

Requires Node 20 or 22. `march spawn dispatch` additionally requires `git` and `docker` on `PATH`.

## Quickstart

```bash
march init           # write ~/.march/march-manifest.json + deploy skills to ~/.claude/
march spawn dispatch # snapshot the current repo's worktree and build a spawn image
```

## Commands

| Command | Description |
|---------|-------------|
| `march init` | Initialize the March environment (manifest + Claude skills under `~/.claude/`). |
| `march update` | Update an existing March installation; prompts on downgrade unless `--yes`. |
| `march spawn dispatch` | Create a worktree, snapshot it as a Docker build context, build `march-spawn-<id>`, and record the spawn. |
| `march version` | Print the installed CLI version. |
| `march help [command]` | Show help for a command. |

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
```

Releases are cut via the `Publish to npm` workflow on GitHub Actions. See [`tests/`](tests/) for the manual test gates that block a release.

## License

MIT — see [LICENSE](LICENSE).
