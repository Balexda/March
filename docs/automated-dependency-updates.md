# Automated Dependency Updates

This repo runs a hands-off pipeline that surfaces vulnerability and version-bump fixes as PRs you review and merge at your leisure. Three pieces work together; each does one thing.

## How it works

```
Advisory disclosed / monthly tick
  ↓
Dependabot opens a PR
  ↓
CI runs
  ├─ pass → review + merge
  └─ fail → fallback workflow comments "@copilot please fix..."
            → Copilot Coding Agent commits to the same branch
            → CI re-runs → review + merge
```

## The three pieces

### 1. Dependabot security updates

Out-of-band channel. The moment a new GHSA advisory is published against a dep, Dependabot opens a PR — no waiting for any cron. This is enabled via a one-time repo toggle (see Setup below) and addresses urgent vulnerabilities as soon as they are disclosed.

### 2. Scheduled version-update PRs

Configured in [`.github/dependabot.yml`](../.github/dependabot.yml).

- **Ecosystems**: `npm` (root) and `github-actions` (workflow files).
- **Schedule**: monthly.
- **Grouping**: minor and patch bumps are consolidated into a single PR per ecosystem; major bumps get their own PRs because that is where breakage actually lives.
- **Caps**: at most 5 open Dependabot PRs at a time, so it cannot flood the queue.
- **Labels**: `dependencies`, `automated`.

### 3. Copilot fallback when CI fails

Configured in [`.github/workflows/dependabot-copilot-fallback.yml`](../.github/workflows/dependabot-copilot-fallback.yml).

When the `CI` workflow fails on a Dependabot-authored PR, this workflow posts a comment on the PR pinging `@copilot` with a link to the failed run. GitHub's Copilot Coding Agent picks up the mention, attempts a fix, and pushes a commit to the same branch. CI re-runs automatically.

The fallback is best-effort. Copilot may resolve the failure cleanly, may make a confused change, or may do nothing. Because every PR still passes through human review, the worst case is a wasted run — nothing ships broken.

## Setup (one-time, per repo)

Three settings must be toggled by hand. None can be configured in code.

1. **Enable Dependabot security updates.**
   `Settings → Code security → Dependabot security updates → Enable`.
   Without this, advisory PRs only arrive on the monthly cron.

2. **Allow workflows to comment on PRs.**
   `Settings → Actions → General → Workflow permissions →` ensure either "Read and write permissions" is selected, or that "Allow GitHub Actions to create and approve pull requests" is checked.
   Without this, the fallback workflow cannot post the `@copilot` comment.

3. **Enable GitHub Copilot Coding Agent.**
   The agent must be enabled on the repo (org or repo-level setting, depending on plan) for the `@copilot` mention to be actioned. Without it, the comment is posted but no fix is attempted; you will see the failed CI on the PR and can handle it manually.

## Day-to-day

You do not need to do anything between disclosures. Expect:

- An occasional Dependabot PR for a security advisory, opened on disclosure.
- One Dependabot PR per month for grouped npm minor/patch bumps; one for grouped GitHub Actions minor/patch bumps; separate PRs for major bumps when applicable.
- Most pass CI directly — review the diff and merge.
- Occasional failing PRs will receive a Copilot fix-up commit within a few minutes. If the failure was straightforward, the second CI run is green and you merge as usual.

## When something looks off

| Symptom | Likely cause | Action |
|---------|--------------|--------|
| Dependabot is silent for weeks despite a known CVE in a dep | Security updates not enabled | Toggle on per Setup #1 |
| Fallback workflow ran but no `@copilot` comment appeared | Workflow permissions block PR comments | Toggle on per Setup #2; re-run the workflow from the Actions tab |
| `@copilot` was pinged but no fix-up commit appears | Copilot Coding Agent not enabled, or it declined the task | Toggle on per Setup #3, or take over manually |
| A major-version bump PR keeps failing across multiple Copilot attempts | Real breaking change | Close the PR, address manually or pin to the previous major |
| Dependabot opens too many PRs at once | Group config not catching the bumps | Tweak the `groups:` rules in `.github/dependabot.yml` |

## Replicating this in another repo

The pattern is repo-agnostic. To roll it out:

1. Copy [`.github/dependabot.yml`](../.github/dependabot.yml). Dependabot does not depend on workflow names, so this file does not need to change.
2. Copy [`.github/workflows/dependabot-copilot-fallback.yml`](../.github/workflows/dependabot-copilot-fallback.yml) and update the `workflows: ["CI"]` line at the top to match the target repo's CI workflow `name:`.
3. Run the three Setup toggles above.
