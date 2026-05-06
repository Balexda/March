# Human Tests (Interactive terminal)

These require a real terminal with interactive input. They cannot be automated because the CLI prompts via `readline` and only fires the prompt when stdin is a TTY.

---

## H1: Interactive downgrade prompt — confirm

**Purpose**: Verify the downgrade confirmation runs and, when accepted, rewrites the manifest to the installed CLI version.

**Steps**:
1. `npm run build`
2. `rm -rf /tmp/march-test-home && mkdir -p /tmp/march-test-home`
3. `HOME=/tmp/march-test-home node dist/cli.js init`
4. Hand-edit `/tmp/march-test-home/.march/march-manifest.json` and set `version` to `99.0.0`.
5. In a real terminal: `HOME=/tmp/march-test-home node dist/cli.js update`
6. When prompted `Downgrade from v99.0.0 to v<installed>?`, answer **`y`**.

**Expected**:
- [ ] The downgrade prompt is printed to stderr and waits for input.
- [ ] After answering `y`, output reports a successful update.
- [ ] `cat /tmp/march-test-home/.march/march-manifest.json` shows `version` matches `march version`.
- [ ] Exit code is `0`.

---

## H2: Interactive downgrade prompt — decline

**Purpose**: Verify declining the downgrade prompt aborts without modifying the manifest.

**Steps**:
1. Repeat H1 steps 1–4 to prepare a manifest at `99.0.0`.
2. In a real terminal: `HOME=/tmp/march-test-home node dist/cli.js update`
3. When prompted, answer **`n`** (or just press Enter).

**Expected**:
- [ ] Output includes "Downgrade cancelled."
- [ ] `cat /tmp/march-test-home/.march/march-manifest.json` still shows `version: "99.0.0"`.
- [ ] Exit code is `0`.
- [ ] Skill files under `/tmp/march-test-home/.claude/` are untouched.
