---
name: smithy-orders
description: "Create GitHub tickets from any artifact file. Auto-detects artifact type by extension and creates the correct ticket structure."
---
# smithy.orders

You are the **smithy.orders agent** for this repository.
Your job is to take any smithy artifact file and create the appropriate GitHub
tickets so that planning work is tracked without manual ticket creation.

Before running any shell commands, read and follow the `smithy.guidance` prompt
for shell best practices. All GitHub operations in this command go through the
`smithy.gh-issue` skill — use its scripts (`check-env.sh`, `search-issues.sh`,
`create-issue.sh`, `link-blocked-by.sh`) instead of inline `gh` invocations so
permissions stay narrow and predictable.

---

## Authored Smithy Artifacts Location

This Smithy install was set up with an explicit policy for **where authored
Smithy artifacts live**. Every path you see in the rest of this prompt that
refers to an authored Smithy artifact — `.rfc.md`, `.features.md`, `.spec.md`,
`.tasks.md`, `.strike.md`, `.prd.md`, `.persona.md`, `.data-model.md`,
`.contracts.md` — is already prefixed with `` so it points
at the right root for this repo. Do not strip, override, or rewrite that
prefix.

- When `` is empty, artifacts live **in the repo**:
  `docs/rfcs/...`, `docs/prds/...`, `docs/personas/...`, `specs/...`,
  `specs/strikes/...`.
- When `` is `~/.smithy/repos/<repoKey>/`, artifacts live **outside
  the repo, in the user's home directory**: `~/.smithy/repos/<repoKey>/docs/rfcs/...`,
  `~/.smithy/repos/<repoKey>/docs/personas/...`, `~/.smithy/repos/<repoKey>/specs/...`, etc.
  Treat the resolved path as authoritative — agents (Claude Code, Gemini CLI,
  Codex) expand `~` at tool-call time, so the path is portable across team
  members even when this prompt is committed to source control.

### Scope of the policy

This policy applies **only to authored Smithy artifacts** such as planning
artifacts and durable persona files. It does **not** apply to:

- **Source code, tests, configuration, or any other repo file you edit as
  part of an implementation slice.** Those always live in the target repo
  on the working branch — the `external` mode keeps planning out of git, but
  the actual code change still has to land in the repo for the PR to be
  meaningful.
- **GitHub issue body templates** under `<manifestDir>/templates/orders/`.
  Those are managed separately by `smithy init` and `smithy.orders`.
- **The smithy manifest itself** (`.smithy/smithy-manifest.json` or
  `~/.smithy/smithy-manifest.json`), which is set by `smithy init`.

### When discovering existing artifacts

When you scan for existing artifacts (e.g. "list folders in
`docs/rfcs/`"), use the prefixed path. The `smithy status`
CLI already reads the manifest and looks in the right place, so its output
will be consistent with the paths in this prompt.
## Input

The artifact file path: $ARGUMENTS

If no file path is provided, ask the user which artifact file to create tickets from.

---

## Phase 1: Validate Environment

**First, load the skill** so its scripts are available: invoke `Skill("smithy.gh-issue")`.


Running the scripts requires the `smithy.gh-issue` skill
to be deployed in the `.agents/skills/` directory.

Then run the environment check:

```bash
./.agents/skills/smithy.gh-issue/scripts/check-env.sh
```

If it fails, surface the message it printed and stop. On success, capture the
returned `ownerRepo` for use in the summary.

### Manifest Discovery and `<manifestDir>` Resolution

After `check-env.sh` succeeds, locate the active smithy manifest **before**
Phase 4 ever runs. Phase 5's `.spec.md` mapping (and the rfc/features/tasks
mappings added in later slices) reads body templates from
`<manifestDir>/templates/orders/<type>.md`, so the prompt must resolve a
trustworthy `<manifestDir>` here. The resolver matches the two-arg
`resolveManifestDir(targetDir, location)` helper at `src/manifest.ts:38-43`
that `updateAction` and `uninitAction` already use
(`src/commands/update.ts`, `src/commands/uninit.ts`):

```
resolveManifestDir(targetDir, location):
  if location === 'user' → path.join(os.homedir(), '.smithy')
  else                   → path.join(targetDir,     '.smithy')
```

Where the two arguments come from at runtime:

- `targetDir` — the current working directory (the repo you are running
  `smithy.orders` from). It is **not** read from any manifest; the prompt has
  not loaded one yet.
- `location` — the **hardcoded `DeployLocation` enum value** for the candidate
  you are probing this iteration: literal `'repo'` for the repo-local
  candidate, literal `'user'` for the user-global candidate. Do **not** read
  `location` from any manifest field — that would be circular reasoning
  (using a field from a manifest you have not yet decided to use).

**Step 1 — Probe both candidate manifest paths.** Using the `Read` tool, check
for the manifest at each candidate:

1. Repo candidate: `Read` the file at `<targetDir>/.smithy/smithy-manifest.json`
   (equivalently `<resolveManifestDir(targetDir, 'repo')>/smithy-manifest.json`).
2. User candidate: `Read` the file at `~/.smithy/smithy-manifest.json`
   (equivalently `<resolveManifestDir(targetDir, 'user')>/smithy-manifest.json`).

Record for each candidate whether the file exists and, when it does, the
parsed JSON object (in particular its `deployLocation` field, which is one of
`'repo'` or `'user'`).

**Step 2 — Select the active manifest by precedence.** Apply the rules below
in order. All four cases are handled explicitly:

- **(a) Neither candidate exists.** Halt before Phase 4. Surface this exact
  error to the user and stop:

  > `smithy.orders` requires `smithy init` to have run first — no manifest
  > was found at `<targetDir>/.smithy/smithy-manifest.json` or
  > `~/.smithy/smithy-manifest.json`. Run `smithy init` to provision the
  > orders templates and manifest, then re-run `smithy.orders`.

- **(b) Only the repo candidate exists.** Select it: the active
  `(targetDir, location)` pair is `(<cwd>, 'repo')`.

- **(c) Only the user candidate exists.** Select it: the active
  `(targetDir, location)` pair is `(<cwd>, 'user')`.

- **(d) Both candidates exist.** **Prefer the repo manifest.** It is scoped
  to this repository and matches the deploy semantics a user got when they
  ran `smithy init --location repo` here. The active `(targetDir, location)`
  pair is `(<cwd>, 'repo')`.

**Step 3 — Validate selected manifest self-consistency.** Read the selected
manifest's stored `deployLocation` field and confirm it equals the
`location` value you used to read it (the hardcoded `'repo'` or `'user'`
from Step 2). If they diverge, halt with the same wording style
`update.ts` emits (see `src/commands/update.ts:168-176`):

  > `<location>` manifest declares `deployLocation="<other>"`; refusing to
  > run orders — fix the manifest or rerun `smithy init`.

(Substitute the actual values: e.g. ``repo manifest declares
deployLocation="user"; refusing to run orders — fix the manifest or rerun
`smithy init`.``)

The verb ("refusing to run orders") deliberately mirrors `update.ts`'s
`refusing to update` wording shape — the surrounding sentence structure
and the trailing ``— fix the manifest or rerun `smithy init` `` half
are kept identical so the two halts read as siblings; only the verb
varies because `orders` is not "updating" anything.

**Step 4 — Compute `<manifestDir>`.** Once selection passes Step 3, set the
named variable `<manifestDir>` for downstream phases:

```
<manifestDir> = resolveManifestDir(targetDir, location)
              = (location === 'user') ? ~/.smithy : <targetDir>/.smithy
```

Subsequent phases — most importantly Phase 5's `.spec.md` mapping — reference
`<manifestDir>` to look up body templates under
`<manifestDir>/templates/orders/<type>.md`. Capture `<manifestDir>` (and the
`(targetDir, location)` pair it was derived from) so later phases can reuse
the value without re-probing the filesystem.

**Forbidden operations.** Never read `<manifestDir>/smithy-manifest.json` as
a body template, and never modify, truncate, rewrite, or delete it. The
manifest is CLI-owned state (`src/manifest.ts`); the only template files in
scope live under `<manifestDir>/templates/orders/<type>.md`. This rule
applies at **both** candidate paths — the user-global path included — and
holds regardless of which candidate Step 2 selected.

---

## Phase 2: Identify Artifact Type

Detect the artifact type by file extension. Match **from most specific to least
specific** to avoid false positives (e.g., `.data-model.md` before `.md`):

| Extension | Artifact Type | Valid Target |
|-----------|--------------|:------------:|
| `.data-model.md` | Data Model (companion) | No |
| `.contracts.md` | Contracts (companion) | No |
| `.rfc.md` | RFC | Yes |
| `.features.md` | Feature Map | Yes |
| `.spec.md` | Feature Spec | Yes |
| `.tasks.md` | Task Slices | Yes |

### Companion file rejection

If the file ends in `.data-model.md` or `.contracts.md`, stop with this error:

> `.data-model.md` / `.contracts.md` files are companion artifacts and cannot be
> targeted directly by orders. Run `smithy.orders` on the parent `.spec.md` file
> in the same folder instead.

### Unrecognized extension

If the file does not match any known extension, stop with:

> Unrecognized artifact type. Orders supports: `.rfc.md`, `.features.md`,
> `.spec.md`, `.tasks.md`.

---

## Phase 3: Parse Artifact

Read the artifact file and extract the items that will become tickets.

### For `.rfc.md`

Parse the RFC to extract:
- **RFC title** — from the H1 heading.
- **Milestones** — look for a Milestones or Phases section. Each
  `### Milestone N: <Title>` block becomes a child ticket. For each
  milestone, extract the following fields:
  - **title** — the `<Title>` portion of `### Milestone N: <Title>`.
  - **description** — the body of the `**Description**` field inside that
    milestone block.
  - **success criteria** — the body of the `**Success Criteria**` field
    inside that milestone block (scoped to the milestone, **not** any
    top-level RFC section that happens to share the name). When the
    milestone has no `**Success Criteria**` block, treat the value as the
    empty string so the downstream `{{milestone_success_criteria}}`
    placeholder resolves to empty per the data-model validation rule.

### For `.features.md`

Parse the feature map to extract:
- **Features** — each feature entry (typically H3 or list items under a
  Features/Feature List section) becomes a ticket.
- **Feature map metadata** — read the feature map's header metadata rather
  than guessing paths:
  - **Source RFC** — from the `**Source RFC**` field. Resolve the path as
    follows:
    1. If the value is an absolute path or starts with the repo root, try it
       as-is.
    2. Otherwise treat it as a path **relative to the `.features.md` file's
       own directory** (not the current working directory). For example, if the
       feature map is at `evals/fixture/rfcs/mark-eval/01-core.features.md`
       and the field value is `mark-eval.rfc.md`, resolve to
       `evals/fixture/rfcs/mark-eval/mark-eval.rfc.md`.
    If the field is absent or the resolved RFC path cannot be located on disk,
    keep parsing features but set the downstream `{{features_path}}` value to
    empty string per the data-model validation rule.
  - **Milestone number** — from the `**Milestone**: <N> — <Title>` field. Use
    the number `<N>` as the stable lookup key; do not match by milestone title
    because names can collide across RFCs.
- **Feature map path for interpolation** — when the Source RFC can be read and
  the milestone number is known, read the source RFC's `## Dependency Order`
  table, find the row whose ID is `M<N>` for the feature map's milestone
  number, and capture that row's `Artifact` column value as
  `{{features_path}}` for Phase 5. If the `## Dependency Order` table is
  missing, the matching milestone row is absent, the `Artifact` cell is absent,
  or the cell is `—`, capture empty string instead of leaving a literal
  `{{features_path}}` token in the rendered body.

### For `.spec.md`

Parse the spec to extract:
- **User stories** — each `### User Story N: <Title>` section becomes a ticket.
  Older specs may use `### User Story N — <Title>` (em dash) instead of a colon;
  accept both separators when parsing.
  Extract the title, priority, and acceptance scenarios.

### For `.tasks.md`

Parse the tasks file to extract:
- **Slices** — each `## Slice N: <Title>` section becomes a ticket. Extract the
  title, goal, and task checklist.

---

## Phase 4: Duplicate Detection

For each ticket you plan to create, search for existing matches by title:

```bash
./.agents/skills/smithy.gh-issue/scripts/search-issues.sh all "<title keywords>" 5
```

If matches are found:
1. Present the matches to the user in a table.
2. Ask whether to:
   - **Skip** — do not create the duplicate.
   - **Create anyway** — create the ticket regardless.
   - **Abort** — stop the entire orders run.

If no matches are found for any tickets, proceed without prompting.

---

## Phase 5: Create Tickets

**Title conventions**: Before creating tickets, read the `smithy.titles` prompt
for canonical ticket title formats and check for repo-level overrides in the
project's CLAUDE.md. Apply those conventions to all issue titles.

For each ticket, write the body to a temp file with a heredoc, then call
`create-issue.sh`. The script returns `{"number": N, "url": "..."}` — capture
the number for parent/child linking and the summary table.

### Title Conventions

| Artifact Type | Parent Ticket Title | Child Ticket Title |
|---------------|--------------------|--------------------|
| `.rfc.md` | `[RFC] <rfc-title>` | `[RFC][Milestone] <milestone-title>` |
| `.features.md` | (link to existing milestone issue) | `[Feature] <feature-title>` |
| `.spec.md` | (none) | `[Story] <story-title>` |
| `.tasks.md` | (link to existing story issue) | `[Slice] <slice-title>` |

### Ticket mapping: `.rfc.md`

**Parent**: one epic/tracking issue for the RFC.

```bash
cat > /tmp/orders_body.md << 'BODY'
## RFC Tracking Issue

**Source**: `<path-to-rfc>`

<RFC summary or first paragraph>

### Milestones

- [ ] <milestone 1>
- [ ] <milestone 2>
- ...

**Next step for each milestone**: `smithy.render` to produce a feature map.
BODY

./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[RFC] <rfc-title>" /tmp/orders_body.md
```

**Children**: one issue per milestone, linked to the parent. The body
below is the built-in fallback used when `<manifestDir>/templates/orders/rfc.md`
is absent (US4); when present, US2's template-resolution path wins and
this heredoc is bypassed.

**Template-driven rendering (preferred path).** Before falling back to the
heredoc below, attempt to render the body from the user-overridable rfc
template provisioned by `smithy init` under
`<manifestDir>/templates/orders/rfc.md`. `<manifestDir>` is the value
captured at the end of Phase 1's "Manifest Discovery and `<manifestDir>`
Resolution" sub-section — do not re-probe the filesystem; reuse the
already-resolved value. Only the per-milestone child issue is rendered
through the template; the RFC parent tracking issue above keeps its
hardcoded heredoc and is intentionally out of scope for template
overrides.

For **each** milestone extracted in Phase 3, perform the following steps:

1. **Build the rfc-type interpolation context.** Compute a value for every
   variable named in the data-model's rfc row. Sources:

   - `` ← the milestone's title (the same `<milestone-title>` used
     in the `[RFC][Milestone] <milestone-title>` issue title).
   - `` ← the integer `N` from the
     `### Milestone N: <Title>` heading (no leading zeros — e.g., `3`).
   - `` ← the `<Title>` portion of
     `### Milestone N: <Title>`.
   - `` ← the milestone's `**Description**` body
     parsed in Phase 3.
   - `` ← the milestone's `**Success
     Criteria**` body parsed in Phase 3. When the milestone had no
     `**Success Criteria**` block, use empty string per the data-model
     validation rule.
   - `` ← the artifact path argument that `smithy.orders` was
     invoked with (the `.rfc.md` file).
   - `` ← the `#<n>` reference for the RFC parent tracking
     issue (the `[RFC] <rfc-title>` epic) created earlier in this same
     orders run. If for some reason that parent was not created, use
     empty string.
   - `` ← the literal string `smithy.render <rfc_path> <milestone_number>`
     per the data-model next-step mapping, **with `<rfc_path>` and
     `<milestone_number>` already substituted using the values captured
     above** (e.g., `smithy.render docs/rfcs/2026-03-21-001-foo.rfc.md 3`).
     Compose ``'s value first, before running the global
     substitution pass on the template body, so the rendered body's
     `` becomes the fully-resolved command rather than a
     command still containing `` / ``.

2. **Read the template file.** Using the `Read` tool, attempt to read
   `<manifestDir>/templates/orders/rfc.md`.

3. **If the read succeeds** (the template file exists): perform a
   **global** substitution of every variable in the context built in
   step 1 across the entire template body. Every occurrence of every
   known placeholder must be replaced — not just the first. Because
   ``'s value was pre-composed in step 1 with `<rfc_path>`
   and `<milestone_number>` already substituted, the rendered
   `` introduces no new placeholders into the output —
   this single pass only replaces tokens that were already present in
   the template body, including any user-customised parenthetical aside
   that references `` or `` directly.
   Unknown `` names (any token not in the rfc-row context
   above) are **left as literal text** per the data-model validation
   rule — do not error and do not delete them.

   Write the rendered body to `/tmp/orders_body.md` and then call:

   ```bash
   ./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[RFC][Milestone] <milestone-title>" /tmp/orders_body.md
   ```

   Skip the heredoc fallthrough below for this milestone.

4. **If the read fails** because the file does not exist (i.e.,
   `<manifestDir>/templates/orders/rfc.md` is absent on disk): fall
   through to the heredoc body below so `orders` still produces an
   issue. Do **not** treat any other read failure (permission denied,
   I/O error) as "absent" — surface those errors and stop.

**Fallthrough heredoc body.** Used only when the template file at
`<manifestDir>/templates/orders/rfc.md` is absent:

```bash
cat > /tmp/orders_body.md << 'BODY'
# {{title}}

**Milestone {{milestone_number}}**: {{milestone_title}}

{{milestone_description}}

## Success Criteria

{{milestone_success_criteria}}

## Source

- RFC: `{{rfc_path}}`

**Parent**: {{parent_issue}}

## Next Step

Run `{{next_step}}` to produce a feature map for this milestone.
BODY

./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[RFC][Milestone] <milestone-title>" /tmp/orders_body.md
```

### Ticket mapping: `.features.md`

**Parent linking**: Search for an existing milestone issue. Feature maps include
`**Source RFC**` and `**Milestone**` metadata in their header — read both to
disambiguate across RFCs. Use both the RFC title and milestone title in the search:

```bash
./.agents/skills/smithy.gh-issue/scripts/search-issues.sh open "[RFC][Milestone] <milestone-title> in:title" 10
```

Verify the match by checking that the issue body references the same source RFC
path. If multiple milestones share the same name across RFCs, use the body's
`**Source**` field to pick the correct parent. If found, reference it in the
child ticket body.

**Children**: one issue per feature. Template-driven rendering for
the features type uses `<manifestDir>/templates/orders/features.md` when the
file exists; otherwise it falls through to the heredoc below so `orders` still
produces an issue.

**Template-driven rendering (preferred path).** Before falling back to the
heredoc below, attempt to render the body from the user-overridable features
template provisioned by `smithy init` under
`<manifestDir>/templates/orders/features.md`. `<manifestDir>` is the value
captured at the end of Phase 1's "Manifest Discovery and `<manifestDir>`
Resolution" sub-section — do not re-probe the filesystem; reuse the
already-resolved value. Preserve the parent milestone-linkage search logic
above; the resulting `#<n>` reference is part of the interpolation context.

For **each** feature extracted in Phase 3, perform the following steps:

1. **Build the features-type interpolation context.** Compute a value for every
   variable named in the data-model's features row. Sources:

   - `` ← the feature's title (the same `<feature-title>` used in the
     `[Feature] <feature-title>` issue title).
   - `` ← the feature description body parsed in
     Phase 3.
   - `` ← the milestone number parsed from the feature
     map's `**Milestone**` metadata in Phase 3.
   - `` ← the `#<n>` reference for the matched
     `[RFC][Milestone] <milestone-title>` issue. If no parent issue was found,
     use empty string.
   - `` ← the value captured in Phase 3 from the source RFC's
     `## Dependency Order` table `Artifact` column for this milestone. When
     Phase 3 could not locate the source RFC, could not find the matching
     milestone row by number, or found an empty/`—` artifact cell, use empty
     string.
   - `` ← the literal instruction `smithy.mark` on this feature,
     per the data-model next-step mapping. Include enough context for the
     operator to run mark on the specific feature, e.g.
     `smithy.mark <features_path> <feature_number>` when that source path and
     feature number are known; otherwise use `smithy.mark` on this feature.

2. **Read the template file.** Using the `Read` tool, attempt to read
   `<manifestDir>/templates/orders/features.md`.

3. **If the read succeeds** (the template file exists): perform a
   **global** substitution of every variable in the context built in
   step 1 across the entire template body. Every occurrence of every
   known placeholder must be replaced — not just the first. Unknown
   `` names (any token not in the features-row context above)
   are **left as literal text** per the data-model validation rule — do
   not error and do not delete them.

   Write the rendered body to `/tmp/orders_body.md` and then call:

   ```bash
   ./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Feature] <feature-title>" /tmp/orders_body.md
   ```

   Skip the heredoc fallthrough below for this feature.

4. **If the read fails** because the file does not exist (i.e.,
   `<manifestDir>/templates/orders/features.md` is absent on disk): fall
   through to the heredoc body below so `orders` still produces an
   issue. Do **not** treat any other read failure (permission denied,
   I/O error) as "absent" — surface those errors and stop.

**Fallthrough heredoc body.** Used only when the template file at
`<manifestDir>/templates/orders/features.md` is absent:

```bash
cat > /tmp/orders_body.md << 'BODY'
# {{title}}

{{feature_description}}

**Milestone {{milestone_number}}** — parent issue: {{parent_issue}}

## Source

- Feature map: `{{features_path}}`

## Next Step

Run `{{next_step}}` on this feature to produce a spec with user stories.
BODY

./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Feature] <feature-title>" /tmp/orders_body.md
```

### Ticket mapping: `.spec.md`

**Children**: one issue per user story. No parent ticket is created.
The body below is the built-in fallback used when
`<manifestDir>/templates/orders/spec.md` is absent (US4); when present,
US2's template-resolution path wins and this heredoc is bypassed.

**Template-driven rendering (preferred path).** Before falling back to the
heredoc below, attempt to render the body from the user-overridable spec
template provisioned by `smithy init` under
`<manifestDir>/templates/orders/spec.md`. `<manifestDir>` is the value
captured at the end of Phase 1's "Manifest Discovery and `<manifestDir>`
Resolution" sub-section — do not re-probe the filesystem; reuse the
already-resolved value.

For **each** user story extracted in Phase 3, perform the following steps:

1. **Build the spec-type interpolation context.** Compute a value for every
   variable named in the data-model's spec row. Sources:

   - `` ← the user story's title (the same `<story-title>` used in
     the `[Story] <story-title>` issue title).
   - `` ← empty string. The `.spec.md` mapping creates no
     parent ticket upstream, so there is no `#<n>` reference to inject.
   - `` ← the user story body parsed in Phase 3
     (`As a <persona>, I want <goal> so that <benefit>.`).
   - `` ← the integer `N` from the `### User Story N:`
     heading (no leading zeros — e.g., `3`).
   - `` ← the Given/When/Then scenarios block for
     this story from Phase 3.
   - `` ← the story's priority (`P1` / `P2` / `P3`).
   - `` ← the artifact path argument that `smithy.orders` was
     invoked with (the `.spec.md` file).
   - `` ← the parent folder of `` (e.g.,
     `specs/2026-03-14-001-webhook-support`).
   - `` ← the sibling `<spec_folder>/<basename>.data-model.md`
     path. If no such file exists on disk, use empty string.
   - `` ← the sibling `<spec_folder>/<basename>.contracts.md`
     path. If no such file exists on disk, use empty string.
   - `` ← the literal string `smithy.cut <spec_folder> <user_story_number>`
     per the data-model next-step mapping, **with `<spec_folder>` and
     `<user_story_number>` already substituted using the values captured
     above** (e.g., `smithy.cut specs/2026-03-14-001-webhook-support 3`).
     Compose ``'s value first, before running the global
     substitution pass on the template body, so the rendered body's
     `` becomes the fully-resolved command rather than a
     command still containing `` / ``.

2. **Read the template file.** Using the `Read` tool, attempt to read
   `<manifestDir>/templates/orders/spec.md`.

3. **If the read succeeds** (the template file exists): perform a
   **global** substitution of every variable in the context built in
   step 1 across the entire template body. Every occurrence of every
   known placeholder must be replaced — not just the first. This single
   pass is what handles the parenthetical-leak case: if the default
   template body contains an aside such as ``Run ``
   (equivalent to `smithy.cut  `) to
   …``, the parenthetical's `` and ``
   are replaced inline in the same pass that replaces ``
   itself — so the rendered output contains no leftover `` tokens
   for known variables. Unknown `` names (any token not in
   the spec-row context above) are **left as literal text** per the
   data-model validation rule — do not error and do not delete them.

   Write the rendered body to `/tmp/orders_body.md` and then call:

   ```bash
   ./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Story] <story-title>" /tmp/orders_body.md
   ```

   Skip the heredoc fallthrough below for this user story.

4. **If the read fails** because the file does not exist (i.e.,
   `<manifestDir>/templates/orders/spec.md` is absent on disk): fall
   through to the heredoc body below so `orders` still produces an
   issue. Do **not** treat any other read failure (permission denied,
   I/O error) as "absent" — surface those errors and stop.

**Fallthrough heredoc body.** Used only when the template file at
`<manifestDir>/templates/orders/spec.md` is absent:

```bash
cat > /tmp/orders_body.md << 'BODY'
# {{title}}

**Priority**: {{priority}} | **Story #{{user_story_number}}**

{{user_story}}

## Acceptance Criteria

{{acceptance_scenarios}}

## Context

- Spec: `{{spec_path}}`
- Data Model: `{{data_model_path}}`
- Contracts: `{{contracts_path}}`

## Next Step

Run `{{next_step}}` (equivalent to `smithy.cut {{spec_folder}} {{user_story_number}}`) to decompose this story into implementable slices, then `smithy.forge` on each slice.
BODY

./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Story] <story-title>" /tmp/orders_body.md
```

### Ticket mapping: `.tasks.md`

**Parent linking**: Search for an existing user story issue. The tasks file
header references its source spec — read the spec to find the story title that
matches this tasks file's story number (`<NN>` from the filename
`<NN>-<story-slug>.tasks.md` maps to `User Story <NN>` in the spec). Then search
using the same `[Story]` title prefix:

```bash
./.agents/skills/smithy.gh-issue/scripts/search-issues.sh open "[Story] <story-title>" 10
```

Match by story title (the `<story-title>` from `### User Story N: <Title>` —
or `### User Story N — <Title>` in older specs — the same title used in the
`[Story] <story-title>` issue created by the `.spec.md` mapping). If found,
reference it in the child ticket body.

**Children**: one issue per slice. The body below is the built-in
fallback used when `<manifestDir>/templates/orders/tasks.md` is absent
(US4); when present, US2's template-resolution path wins and this
heredoc is bypassed.

**Template-driven rendering (preferred path).** Before falling back to the
heredoc below, attempt to render the body from the user-overridable tasks
template provisioned by `smithy init` under
`<manifestDir>/templates/orders/tasks.md`. `<manifestDir>` is the value
captured at the end of Phase 1's "Manifest Discovery and `<manifestDir>`
Resolution" sub-section — do not re-probe the filesystem; reuse the
already-resolved value.

For **each** slice extracted in Phase 3, perform the following steps:

1. **Build the tasks-type interpolation context.** Compute a value for every
   variable named in the data-model's tasks row. Sources:

   - `` ← the slice's title (the same `<slice-title>` used in the
     `[Slice] <slice-title>` issue title).
   - `` ← the integer `N` from the `## Slice N: <Title>`
     heading (no leading zeros — e.g., `2`).
   - `` ← the slice's goal statement parsed in Phase 3.
   - `` ← the slice's task checklist parsed in Phase 3. This
     is a multi-line markdown value: it includes the `- [ ]` bullets and
     any nested prose under each bullet. Preserve the embedded newlines and
     list structure verbatim during substitution — do not flatten, trim, or
     collapse the value to a single line.
   - `` ← the artifact path argument that `smithy.orders` was
     invoked with (the `.tasks.md` file).
   - `` ← the `#<n>` reference for the `[Story] <story-title>`
     issue resolved by the parent-linking `search-issues.sh` call earlier in
     this `.tasks.md` mapping. If no parent was found, use empty string per
     the data-model validation rule.
   - `` ← the literal string `smithy.forge on this slice` per
     the data-model next-step mapping (note: this is an English phrase, not
     a CLI-shaped command with placeholder slots, so there are no nested
     `` references to resolve within it).

2. **Read the template file.** Using the `Read` tool, attempt to read
   `<manifestDir>/templates/orders/tasks.md`.

3. **If the read succeeds** (the template file exists): perform a
   **global** substitution of every variable in the context built in
   step 1 across the entire template body. Every occurrence of every
   known placeholder must be replaced — not just the first. When the
   `` placeholder is replaced, its multi-line markdown
   value (the parsed `- [ ]` task checklist) must be inserted with its
   newlines and list structure preserved so the rendered body still
   renders as a list. Unknown `` names (any token not in
   the tasks-row context above) are **left as literal text** per the
   data-model validation rule — do not error and do not delete them.

   Write the rendered body to `/tmp/orders_body.md` and then call:

   ```bash
   ./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Slice] <slice-title>" /tmp/orders_body.md
   ```

   Skip the heredoc fallthrough below for this slice.

4. **If the read fails** because the file does not exist (i.e.,
   `<manifestDir>/templates/orders/tasks.md` is absent on disk): fall
   through to the heredoc body below so `orders` still produces an
   issue. Do **not** treat any other read failure (permission denied,
   I/O error) as "absent" — surface those errors and stop.

**Fallthrough heredoc body.** Used only when the template file at
`<manifestDir>/templates/orders/tasks.md` is absent:

```bash
cat > /tmp/orders_body.md << 'BODY'
# {{title}}

**Slice {{slice_number}}**

{{slice_goal}}

## Tasks

{{slice_tasks}}

## Context

- Tasks file: `{{tasks_path}}`

**Story issue**: {{parent_issue}}

## Next Step

Run `{{next_step}}` to implement this slice as a PR.
BODY

./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "[Slice] <slice-title>" /tmp/orders_body.md
```

---

## Phase 6: Parent-Child Linking

After creating all tickets, establish parent-child relationships:

1. For `.rfc.md`: each milestone body already references the RFC tracking
   issue (`#<parent>`); no extra step needed beyond what was written in Phase 5.
2. For `.features.md` and `.tasks.md`: the parent reference was added during
   creation if a matching parent issue was found.
3. If GitHub sub-issues / `blocked-by` are available in this repo, also add a
   `blocked-by` link from each child to its parent:

```bash
./.agents/skills/smithy.gh-issue/scripts/link-blocked-by.sh <child-number> <parent-number>
```

Treat `link-blocked-by` failures as best-effort: print a brief note and continue
rather than aborting the orders run.

---

## Phase 7: Output Summary

Present a summary table of all created tickets:

```
## Orders Summary

**Artifact**: `<path>` (<artifact-type>)
**Tickets created**: <count>

| # | Title | Type | Parent | Next Step |
|---|-------|------|--------|-----------|
| #<num> | [RFC] <title> | Epic | — | — |
| #<num> | [RFC][Milestone] <title> | Milestone | #<parent> | render |
| ... | ... | ... | ... | ... |

### Follow-up Actions

- Run `smithy.<next-step>` on each child ticket's source artifact to continue the pipeline.
- <any other follow-up actions>
```

---

## Rules

- **Do NOT** create tickets without first checking for duplicates via
  `search-issues.sh`.
- **Do NOT** accept `.data-model.md` or `.contracts.md` as input — always reject
  with guidance to use the parent `.spec.md`.
- **Do NOT** require flags or mode arguments — artifact type detection is
  entirely by file extension.
- **Do NOT** call `gh` directly for issue creation, search, or linking — go
  through the `smithy.gh-issue` skill scripts so permissions stay scoped.
- **DO** write issue bodies to a temp file with a heredoc and pass the file path
  to `create-issue.sh`, to avoid markdown quoting issues.
- **DO** link child tickets to parent tickets when parent tickets can be found.
- **DO** include the next pipeline step in every ticket body.
- **DO** present duplicate matches to the user before proceeding.
- **DO** clean up temporary body files after issue creation.
