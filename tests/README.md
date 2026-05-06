# Manual Test Cases

Pre-release checklist for tests that cannot be fully automated. Run these before publishing a new version.

## Test Files

| File | Runner | Description |
|------|--------|-------------|
| [Agent.tests.md](Agent.tests.md) | Claude Code agent or developer in a Claude Code session | Verifies `march init` deploys the expected skills, `march update` advances the manifest, and `march spawn dispatch` produces a tagged image + SpawnRecord on a real repo. |
| [Manual.tests.md](Manual.tests.md) | Developer at an interactive terminal | Verifies the interactive `march update` downgrade prompt, which cannot be driven from non-TTY stdin. |

## Setup

Before running any manual test case:

1. **Build the CLI**:
   ```bash
   npm run build
   ```

2. **Ensure automated tests pass**:
   ```bash
   npm test
   ```

3. **Use a clean home directory** (agent tests use `MARCH_HOME=/tmp/march-test-home` where supported, or `HOME=/tmp/march-test-home` for full isolation):
   ```bash
   rm -rf /tmp/march-test-home
   mkdir -p /tmp/march-test-home
   ```

4. **For agent tests (A-series)**: run them in a Claude Code session with access to this repo, or delegate them to a Claude agent.

5. **For human tests (H-series)**: run them in a real terminal with interactive input. They cannot be piped or scripted.

## Cleanup

After running tests, remove temp directories and any spawn artifacts:

```bash
rm -rf /tmp/march-test-home /tmp/march-test-repo
docker images --filter "reference=march-spawn-*" -q | xargs -r docker rmi
```
