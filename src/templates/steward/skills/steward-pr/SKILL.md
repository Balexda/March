---
name: steward-pr
description: "Open the pull request for a completed Steward spawn. Use after the worker's patch is applied/committed and pushed, when you (the Hatchery manager/steward session) need to create the PR. Defines the required title and body format: a parentage-grounded Summary, surfaced spec debt + uncertainty, and a one-line validation summary — no per-file Changes dump."
allowed-tools: Bash(git status*) Bash(git log*) Bash(git diff*) Bash(git branch --show-current) Bash(gh pr create*) Bash(gh pr view*)
---
# steward-pr

You are the **Steward** opening the pull request for one completed Smithy
workflow step. The worker's change is already staged/committed in this worktree
and the branch is pushed. Your job here is **only** to compose and create the PR
with the title and body format below, then report the PR URL.

This skill owns the **PR title + body convention** for every automated steward
PR. Follow it exactly — these PRs are read in bulk by a single operator, so
every wasted line costs.

## Inputs you already have

- **The Smithy command** that produced this work (e.g. `smithy.forge … 1`,
  `smithy.cut …`) — from your original request.
- **The artifact path** the command targeted (e.g.
  `specs/<spec-folder>/NN-<slug>.tasks.md`) — from your original request.
- **The staged diff** and **commit log** in this worktree.
- **The artifact files themselves**, readable in this worktree — read them to
  derive parentage and spec debt (below). Do not guess from memory.

## Title

```
<verb>: <concise goal>
```

- `<verb>` is the **Smithy verb with the `smithy.` prefix stripped** —
  `forge`, `cut`, `mark`, `render`, `strike`, `spark`, `ignite`, `engrave`,
  `audit`, or `fix`. **Never** prefix it with `smithy ` (no `smithy forge:`).
- `<concise goal>` is the slice/step goal in plain words, ≤ ~70 chars total.
- **Do NOT** put `US#`, `S#`, slice numbers, FR numbers, or acceptance-scenario
  IDs in the title — they are spec-internal and meaningless to later readers.

Good: `forge: bounded spawn output capture envelope`
Bad:  `smithy forge: US1 S1 bounded spawn output capture envelope`

## Body

Exactly these three sections, in this order. **Do not add a `## Changes`
section** — the diff, commit log, and linked artifact already carry per-file
detail; restating it just buries the signal.

```
## Summary
<RFC id> → M<n> <milestone> → F<n> <feature> → <spec name> → Slice <n>: <goal>
<1–2 sentences: what this slice adds and why it is the right increment.>

## Spec debt & uncertainty
- <SD-NNN (open|inherited): one-line description>
- Assumption: <a relevant assumption that shaped this work>
- <any verification gap you hit, e.g. "could not run integration suite — no Docker">

## Validation
build ✅ · typecheck ✅ · test ✅ (N passed)
```

### Composing the Summary parentage breadcrumb

Walk the artifact headers (read the files; relative paths are repo-rooted):

1. Open the **tasks/strike artifact** at the command's path. Its `**Source**:`
   line names the **spec** file (and the user-story number). Read the slice's
   `## Slice <n> … **Goal**:` for the goal text.
2. Open that **spec** file. Its `**Input**:` line names the **RFC** and the
   **milestone** (e.g. "… Milestone 1: Spawn"); its `**Source Feature Map**:`
   line names the **feature** (e.g. "Feature 5: Spawn Output Extraction").
3. Assemble: `RFC <id> → M<n> <milestone> → F<n> <feature> → <spec> → Slice <n>: <goal>`.

If a link is genuinely absent (e.g. a `.strike.md` with no spec), include the
breadcrumb you can build and skip the rest — do not fabricate ancestry.

### Surfacing spec debt & uncertainty

This is the highest-value section for steering — make it accurate.

- Read the artifact's `## Specification Debt` table. List every row whose
  `Status` is **`open`** or **`inherited`** as a one-liner:
  `SD-NNN (open): <Description>`. Skip `resolved` rows.
- Read the spec's `## Assumptions` section; surface any assumption that
  materially shaped this slice's implementation.
- Add any **verification gap or uncertainty you personally hit** while
  reviewing/validating the diff (untested path, ambiguous requirement, a
  decision you had to make).
- If there is genuinely nothing outstanding, write exactly: `None outstanding.`

### Validation

One line summarizing the commands you ran and their outcomes — e.g.
`build ✅ · typecheck ✅ · test ✅ (95 passed)`. State failures or skips plainly
rather than implying everything passed.

## Create the PR

1. Confirm the branch is pushed (`git branch --show-current`, then ensure the
   remote has it — your launch workflow already pushed it).
2. Create the PR against the **exact pushed branch** — do not rename it or add a
   `feature/` prefix; downstream PR discovery tracks the branch by name.
   Prefer `gh pr create --title "<title>" --body "<body>"`.
3. Report the PR URL on the **final line** of your reply as `PR: <url>`.
4. If any step fails, escalate via
   `NEED: <one-line summary> — <one-line next action>` instead of stopping
   silently. Never end your turn after a push without either an opened PR or a
   `NEED:` — a stranded steward requires manual recovery.
