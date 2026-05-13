# Agent Tests (Claude Code session)

Run these in a Claude Code session with access to the March repo. They can also be delegated to a Claude agent.

All tests assume the CLI has already been built (`npm run build`) and `dist/cli.js` is the artifact under test. Use a throwaway `HOME` so the tests do not touch your real `~/.claude` or `~/.march`.

---

## A1: `march init` deploys the manifest and Claude skills

**Purpose**: Verify `march init` writes `~/.march/march-manifest.json` and deploys the M1 skill files into `~/.claude/commands/` and `~/.claude/prompts/`.

**Steps**:
```bash
cd /path/to/March
rm -rf /tmp/march-test-home && mkdir -p /tmp/march-test-home
HOME=/tmp/march-test-home node dist/cli.js init
ls /tmp/march-test-home/.march
ls /tmp/march-test-home/.claude/commands
ls /tmp/march-test-home/.claude/prompts
cat /tmp/march-test-home/.march/march-manifest.json
```

**Expected**:
- [ ] `~/.march/march-manifest.json` exists and is valid JSON with the installed CLI version.
- [ ] `~/.claude/commands/` contains `march.spawn-dispatch.md` and `march.spawn-status.md`.
- [ ] `~/.claude/prompts/` contains `march.output-handling.md`.
- [ ] Manifest `files.claude` lists exactly the three deployed paths.
- [ ] Re-running `march init` exits non-zero with "March is already installed. Run `march update` to upgrade."

---

## A2: `march update` advances the manifest version

**Purpose**: Verify `march update` rewrites the manifest with the currently installed CLI version when the on-disk manifest is older.

**Steps**:
```bash
HOME=/tmp/march-test-home node dist/cli.js init
# Hand-edit the manifest to a lower version to simulate an upgrade.
node -e 'const f="/tmp/march-test-home/.march/march-manifest.json";const m=JSON.parse(require("fs").readFileSync(f,"utf8"));m.version="0.0.1";require("fs").writeFileSync(f,JSON.stringify(m,null,2))'
HOME=/tmp/march-test-home node dist/cli.js update
cat /tmp/march-test-home/.march/march-manifest.json
```

**Expected**:
- [ ] Update reports a successful upgrade summary (no downgrade prompt).
- [ ] Manifest `version` field now matches `march version`.
- [ ] Skill files in `~/.claude/commands/` and `~/.claude/prompts/` are still present.

---

## A3: `march update` refuses a non-interactive downgrade without `--yes`

**Purpose**: Verify the downgrade guardrail when stdin is not a TTY.

**Steps**:
```bash
HOME=/tmp/march-test-home node dist/cli.js init
# Hand-edit the manifest to a version higher than the installed CLI.
node -e 'const f="/tmp/march-test-home/.march/march-manifest.json";const m=JSON.parse(require("fs").readFileSync(f,"utf8"));m.version="99.0.0";require("fs").writeFileSync(f,JSON.stringify(m,null,2))'
HOME=/tmp/march-test-home node dist/cli.js update </dev/null
cat /tmp/march-test-home/.march/march-manifest.json
```

**Expected**:
- [ ] Output mentions a downgrade and instructs "Pass --yes to force the downgrade in non-interactive mode."
- [ ] Exit code is `0` (informational, not failure).
- [ ] Manifest `version` field is unchanged at `99.0.0`.
- [ ] Re-running with `--yes` (`HOME=… node dist/cli.js update --yes </dev/null`) rewrites the version to the installed CLI.

---

## A4: `march spawn dispatch` builds a tagged image and writes a SpawnRecord

**Purpose**: End-to-end check that dispatch creates a worktree, builds `march-spawn-<id>`, and writes a `created` SpawnRecord. Requires `git` and `docker` on `PATH` and the configured base image to be pullable.

**Steps**:
```bash
# Prepare a throwaway repo with at least one commit.
rm -rf /tmp/march-test-repo && mkdir -p /tmp/march-test-repo
git -C /tmp/march-test-repo init -q -b main
echo hello > /tmp/march-test-repo/README.md
git -C /tmp/march-test-repo add README.md
git -C /tmp/march-test-repo -c user.email=t@t -c user.name=t commit -q -m init

cd /tmp/march-test-repo
HOME=/tmp/march-test-home node /path/to/March/dist/cli.js spawn dispatch

ls /tmp/march-test-home/.march/spawns
docker images --filter "reference=march-spawn-*" --format '{{.Repository}}:{{.Tag}}'
git -C /tmp/march-test-repo worktree list
```

**Expected**:
- [ ] Command exits `0` with a success summary referencing a spawn id.
- [ ] `~/.march/spawns/<id>.json` exists with `state: "created"` and an `imageId` field.
- [ ] `docker images` shows a `march-spawn-<id>` tag matching the SpawnRecord.
- [ ] `git worktree list` includes a `march-spawn-<id>` worktree under the test repo.

**Cleanup**:
```bash
docker rmi $(docker images --filter "reference=march-spawn-*" -q) || true
git -C /tmp/march-test-repo worktree list --porcelain | awk '/^worktree / && $2 ~ /march-spawn-/ {print $2}' | xargs -r -n1 git -C /tmp/march-test-repo worktree remove --force
rm -rf /tmp/march-test-home /tmp/march-test-repo
```

---

## A5: `march spawn dispatch` rolls back on a build failure

**Purpose**: Verify the failure path: on a docker build failure the SpawnRecord transitions to `failed` and the worktree + branch are removed.

**Steps**:
1. Repeat the A4 setup, but point dispatch at a base image that does not exist (e.g., temporarily edit `src/hatchery/spawn-config.ts` to set `BASE_IMAGE` to `does-not-exist:bogus`, then `npm run build`). Or pull the dispatch image, then `docker rmi --force` it after dispatch begins — whichever is easier in your environment.
2. Run `march spawn dispatch` against `/tmp/march-test-repo`.

**Expected**:
- [ ] Command exits non-zero with a clear error.
- [ ] `~/.march/spawns/<id>.json` exists with `state: "failed"` and an `error` field describing the build failure.
- [ ] `git worktree list` does **not** show a `march-spawn-<id>` worktree.
- [ ] No `march-spawn-<id>` Docker image is left behind.

Restore the original `BASE_IMAGE` and rebuild before moving on.
