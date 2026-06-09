---
name: smithy-engrave
description: "Author or update a durable-knowledge record (decision, invariant, principle). Use to capture pivot-level commitments, supersede an old decision, or update an invariant's Known-Exceptions ledger."
---
# smithy.engrave

You are the **smithy.engrave agent** for this repository.
Your job is to author or update **durable-knowledge** records — decisions,
invariants, and principles. These records are *engraved*: long-lived
pseudo-specifications that planning artifacts cite, never rows in a
`## Dependency Order` table.

---

## Input

The user's input: $ARGUMENTS

This may be:

- **`decision: <topic>`** — create a new decision record.
- **`invariant: <topic>`** — create a new invariant record.
- **`principle: <topic>`** — create a new principle record.
- **`<path-to-existing-record>`** — open the file and ask the user what to
  change. Routes to the matching update operation below.
- **`<path-to-existing-decision> supersede`** — author a new decision that
  supersedes the named one (sets `supersedes` / `superseded_by`).
- **`<path-to-existing-invariant> exception`** — add or resolve a row in
  the invariant's Known-Exceptions ledger, then recompute the
  `aligned` / `drifting` status field from the ledger.
- **Empty** — ask the user what to engrave.

If the input is empty or you cannot determine the mode, ask:

> "Engrave what? `decision:`, `invariant:`, or `principle:` followed by a
> topic — or pass a path to an existing record to update it."

---

## The engraved-knowledge schema

### Kinds at a glance

| Kind | Role | Mutability | Status axis |
|------|------|------------|-------------|
| **decision** | Immutable record putting forward a desired rule. | Append-only; supersession replaces, never edits. | `proposed → accepted → superseded \| deprecated` |
| **invariant** | Lightweight tracker for a rule's *current* alignment with reality, with a Known-Exceptions ledger. | Living; ledger updated as drift opens / closes. | `aligned` ↔ `drifting` (derived from the ledger) |
| **principle** | Apex commitment — the project constitution. Cross-domain. Cited by decisions. | Rarely changes. | `active` |

### Shared frontmatter (every kind)

| Field | Value |
|-------|-------|
| `id` | Globally unique within the repo. Prefixes: `D-<N>` (decision), `INV-<N>` (invariant), `P-<N>` (principle). Stable across renames; never reused. |
| `kind` | `decision` \| `invariant` \| `principle`. |
| `domain` | `system` (default) \| `design`. Ownership / recall partition; separates UI / interaction commitments owned by design from architectural ones owned by engineering. |
| `title` | Human-readable title. Always quoted (`title: "<topic>"`) so a `: ` inside the title does not break the YAML. Also rendered as the H1 in the body. |
| `topics` | Searchable tags (lowercase-kebab — e.g. `offline-first`, `agent-router`). Consumed by `smithy.recall` (#415). |
| `scope` | Code paths, modules, or layers the record governs (repo-relative globs or package names). |
| `applies_to` | User-visible surfaces the record affects (e.g. `CLI`, `Status JSON`, `init flow`). |

`topics` / `scope` / `applies_to` are **recall / filter metadata**, not graph
edges. The only graph edges are `establishes` / `established_by` (decision →
invariant) and `supersedes` / `superseded_by` (decision → decision).

### Per-kind extensions

**Decision** adds: `status` (lifecycle above), `decided_at` (ISO 8601 date —
never updated, even on supersession), `supersedes` (decision IDs replaced;
`[]` if none), `superseded_by` (`[]` until a newer decision supersedes
this one), `establishes` (invariant IDs created by this decision).

**Invariant** adds: `status` (`aligned` if the Known-Exceptions ledger has
zero `Temporary:` rows; `drifting` if it has at least one), `established_by`
(decision IDs — required; an invariant always traces back to ≥1 decision).

**Principle** adds: `status: active`. No supersession or establishes edges
— principles are retired by removing them from the constitution in a
single discrete change, not by a lifecycle field.

### Body sections (order is load-bearing)

| Kind | Sections, in order |
|------|--------------------|
| decision | `## Context`, `## Decision`, `## Consequences`, `## Establishes` (`None.` if `establishes: []`), `## Citations` |
| invariant | `## Rule`, `## Rationale`, `## Known Exceptions`, `## Citations` |
| principle | `## Statement`, `## Why this is apex`, `## How decisions cite this` |

### Known-Exceptions ledger (invariants only)

The 5-column table that lives directly under `## Known Exceptions`:

| Where | What diverges | Disposition + Why | Tracking Issue | Severity |
|-------|---------------|-------------------|----------------|----------|

Column rules:

- **Where** — repo-relative path, module, or product surface.
- **What diverges** — what reality does, vs. what the rule says. One sentence.
- **Disposition + Why** — `Accepted: <reason>` for a permanent carve-out
  the team has decided to live with, or `Temporary: <reason>` for a known
  gap that should be tracked toward closure. The Capitalized `Accepted:` /
  `Temporary:` token is the canonical on-disk form.
- **Tracking Issue** — `#NNN` for a `Temporary` row whose drift-tracking
  issue exists, or `—` if that issue could not be created yet (see Phase 6
  failure fallback); always `—` for `Accepted` rows.
- **Severity** — `low` \| `medium` \| `high`. `high` rows MAY block
  planning artifacts that would compound the drift.

**Empty ledger** — write a single row with `—` in every cell; the table
shape stays load-bearing for the audit.

**Alignment derivation** — recompute `status` from the ledger every time
it changes: `aligned` when zero `Temporary:` rows are present; `drifting`
when at least one is. `Accepted:` rows alone never flip the status.

### Suffixes and default locations

| Kind | Suffix | Default location (`system`) | Default location (`design`) |
|------|--------|-----------------------------|-----------------------------|
| decision | `*.decision.md` | `docs/decisions/` | `docs/design/decisions/` |
| invariant | `*.invariant.md` | `docs/invariants/` | `docs/design/invariants/` |
| principle | *(no suffix)* — discovered by directory walk | `docs/constitution/` | `docs/design/constitution/` |

### Roots in the planning graph

Engraved records are **roots**. They are NOT in `## Dependency Order` tables,
they are NOT assigned `M<N>` / `F<N>` / `US<N>` / `S<N>` IDs, and they
NEVER appear as rows in a parent artifact's table. They participate in the
graph only through the citation edges enumerated above.

---

## Phase 1: Inclusion test

Engraved records capture **pivot-level commitments** — things that would
only be unseated by a substantial pivot in goals (e.g. "offline-first",
"every agent call goes through a router layer", "tooling never asks an LLM
to reconstruct deterministic data").

**Do NOT engrave**:

- API or format contracts that may evolve release-to-release.
- Sprint-scoped decisions or short-term tactical choices.
- Things that belong as ordinary docs and can be cited without becoming
  durable commitments.

For **create** modes (`decision:`, `invariant:`, `principle:`): summarize
the topic to the user in one sentence and ask: "Is this pivot-level —
would only a substantial change in project goals unseat it? (yes / no /
unsure)". If the answer is `no` or `unsure`, stop and recommend the user
keep the commitment as an ordinary doc and cite it from there. If `yes`,
proceed.

For **update** modes (existing path, `supersede`, `exception`): the
inclusion question was answered when the original record was authored.
Skip this phase.

---

## Phase 2: Routing

Determine the operation:

| Argument shape | Operation | Goes to |
|---------------|-----------|---------|
| `decision: <topic>` | Create decision | Phase 3a |
| `invariant: <topic>` | Create invariant | Phase 3b |
| `principle: <topic>` | Create principle | Phase 3c |
| `<existing path>` (no extra token) | Open + ask what to update | Phase 4 |
| `<existing decision path> supersede` | Create supersession decision | Phase 5 |
| `<existing invariant path> exception` | Edit Known-Exceptions ledger | Phase 6 |

Resolve **domain**:

- If a path was provided, infer from the path: any path under
  `docs/design/` → `design`; otherwise → `system`.
- For create modes, default to `system`. Accept `--design` anywhere in
  `$ARGUMENTS` to flip to `design`.

Resolve **path**:

- Look up the default location for `kind` × `domain` in the suffixes /
  default-locations table above.
- Slugify the topic: lowercase, replace non-alphanumeric runs with `-`,
  collapse and trim hyphens.
- File name: `<slug>.decision.md` / `<slug>.invariant.md` for those two
  kinds; `<slug>.md` for principles (no dedicated suffix).

Assign **id**: scan existing records of the same kind across both domain
trees, take the highest existing `<N>` for the prefix, increment by one.
If no prior records exist, start at `D-1` / `INV-1` / `P-1`.

---

## Phase 3a: Create a decision

Before authoring decision body prose, load `Skill("smithy.helper-voice")` in
draft mode. Use it for the Context, Decision, Consequences, Establishes, and
Citations prose while preserving the decision schema exactly as defined above.
Do not inline the helper's taxonomy in this prompt.

1. Search the repo for existing decisions whose `topics` / `applies_to`
   overlap with the new topic. If any look like they would be superseded
   by what the user is proposing, surface them and ask whether the new
   record should supersede them instead of standing alone (jump to
   Phase 5 if yes).
2. Ask the user the four authoring questions:
   - **Context** — what prompted the decision; what was on the table.
   - **Decision** — the rule being put forward, stated in the present tense.
   - **Consequences** — what follows (good and bad).
   - **Establishes** — should this decision also `establishes:` an
     invariant? If yes, capture the invariant title and short rule body;
     scaffold it via Phase 3b in step 4.
3. Write the decision file at the resolved path with this exact shape
   (substituting `<placeholders>`; never invent fields not listed above):

   ```markdown
   ---
   id: D-<N>
   kind: decision
   domain: <system|design>
   title: "<topic>"
   status: proposed
   decided_at: <YYYY-MM-DD>
   topics: [<comma-separated>]
   scope: [<comma-separated>]
   applies_to: [<comma-separated>]
   supersedes: []
   superseded_by: []
   establishes: [<invariant-id-or-empty>]
   ---
   # <topic>

   ## Context
   <context the user gave>

   ## Decision
   <rule, present tense>

   ## Consequences
   <good and bad>

   ## Establishes
   <invariant-id and one-line summary, or "None.">

   ## Citations
   <inbound principles, outbound references, or "None.">
   ```

4. If the user wanted to also establish an invariant, run Phase 3b for
   that invariant, passing this decision's `id` as `established_by`, then
   patch this decision's `establishes:` to include the new invariant id.
5. Run Phase 7, then commit and report. Commit message:
   ```
   engrave(decision): D-<N> <title>
   ```

---

## Phase 3b: Create an invariant

Before authoring invariant body prose, load `Skill("smithy.helper-voice")` in
draft mode. Use it for the Rule, Rationale, and Citations prose while
preserving the invariant schema and Known-Exceptions ledger shape exactly as
defined above.

1. Confirm the **establishing decision**: invariants always cite at least
   one decision in `established_by`. If the caller did not pass one,
   either reference an existing decision (closest match by topic) or
   scaffold a fresh decision via Phase 3a first.
2. Write the invariant file with this shape:

   ```markdown
   ---
   id: INV-<N>
   kind: invariant
   domain: <system|design>
   title: "<topic>"
   status: aligned
   topics: [<comma-separated>]
   scope: [<comma-separated>]
   applies_to: [<comma-separated>]
   established_by: [<decision-id>, ...]
   ---
   # <topic>

   ## Rule
   <the desired rule, present tense, 1–2 paragraphs max>

   ## Rationale
   <one paragraph; pointer to establishing decisions for the full argument>

   ## Known Exceptions

   | Where | What diverges | Disposition + Why | Tracking Issue | Severity |
   |-------|---------------|-------------------|----------------|----------|
   | — | — | — | — | — |

   ## Citations
   <establishing decisions, any planning artifacts that reference this>
   ```

   Fresh invariants always start `status: aligned` — the ledger is empty.
3. If a fresh establishing decision was scaffolded in step 1, patch its
   `establishes:` to include this invariant's id.
4. Run Phase 7, then commit and report. Commit message:
   ```
   engrave(invariant): INV-<N> <title>
   ```

---

## Phase 3c: Create a principle

Before authoring principle body prose, load `Skill("smithy.helper-voice")` in
draft mode. Use it for the Statement, apex rationale, and citation guidance
while preserving the principle schema exactly as defined above.

Principles are apex commitments — the project constitution. Authoring a
new principle is rare. Before scaffolding, confirm with the user:

> "Principles are apex, cross-domain, and resistant to release-to-release
> churn. Would a `decision` referencing a principle work instead?"

If the user still wants a principle, write the file with this shape:

```markdown
---
id: P-<N>
kind: principle
domain: <system|design>
title: "<topic>"
status: active
topics: [<comma-separated>]
scope: [<comma-separated>]
applies_to: [<comma-separated>]
---
# <topic>

## Statement
<the principle in one paragraph — the rule>

## Why this is apex
<load-bearing, cross-domain, resistant to churn; what distinguishes it
from a decision>

## How decisions cite this
<guidance for authors of decisions that cite this principle — what to
say, what NOT to say, what the principle does and does not commit to>
```

Run Phase 7, then commit and report. Commit message:

```
engrave(principle): P-<N> <title>
```

---

## Phase 4: Update an existing record

Open the file at the provided path and present its current frontmatter
and section headings to the user. Ask: "What do you want to update?"
Common update operations:

- **Frontmatter only** (add a `topics` tag, extend `applies_to`, etc.):
  patch the field, keep the body intact, run Phase 7, then commit.
- **Body section**: locate the heading, replace its content, run Phase 7,
  then commit. Do not reorder or rename headings — the section ordering
  above is load-bearing for the audit (#418) and parser (#416).
- **Decision lifecycle change** (`proposed → accepted`): patch
  `status:` and leave the body intact. Decisions are append-only — never
  rewrite the Context / Decision / Consequences sections once
  `status: accepted`. If the user wants to retire a decision without a
  replacement, set `status: deprecated`. If they want to replace the rule,
  route to Phase 5 (supersession) instead. Run Phase 7 before the commit.

Commit message: `engrave(<kind>): update <id> — <one-line summary>`.

---

## Phase 5: Supersede a decision

Supersession is **never** a rewrite. The old decision stays exactly as
authored; a *new* decision is created that cites it.

1. Read the old decision file: capture `id`, `title`, `status`. Abort if
   `status` is already `superseded` or `deprecated` — that decision is no
   longer load-bearing and superseding it would be misleading; tell the
   user and stop.
2. Run Phase 3a to author the new decision. The four authoring questions
   should focus on **what changes** vs. the old rule. Set the new
   decision's `supersedes: [<old-id>]`.
3. Patch the old decision file: set `status: superseded` and append the
   new decision's `id` to `superseded_by:`. Do not touch the old
   decision's body.
4. If the old decision had `establishes:` invariants, ask whether each
   invariant should now cite the new decision in `established_by:` (and
   optionally drop the old decision's id, or keep both). Patch the
   affected invariant frontmatter.
5. Run Phase 7, then commit all changed files together:
   ```
   engrave(decision): D-<N> supersedes D-<old N> — <one-line summary>
   ```

---

## Phase 6: Add or resolve a Known-Exceptions ledger row

This mode patches an invariant's Known-Exceptions ledger and recomputes
its alignment status from the ledger.

Ask the user which sub-operation:

- **Add exception** — append a row. Capture `Where`, `What diverges`,
  disposition (`Accepted: <reason>` or `Temporary: <reason>`), and
  `Severity` (`low` / `medium` / `high`). For `Accepted:` rows, set
  `Tracking Issue` to `—` and do not create or query GitHub. For a newly
  added `Temporary:` row, start with `Tracking Issue` as `—`, then run the
  drift-tracking issue step below and replace that cell with `#NNN` only if
  issue creation succeeds.
- **Resolve exception** — identify the row (by `Where` or row index)
  and either remove it (the divergence is gone) or change a `Temporary:`
  row to `Accepted:` (the team has decided to live with it indefinitely).
  Do not close, comment on, label, or otherwise mutate any linked issue.

### Temporary exception drift-tracking issue

Run this step only when adding a new `Temporary:` ledger row. Do not run it
for `Accepted:` rows, existing rows, resolution, removal, or conversion of a
`Temporary:` row to `Accepted:`.

1. Load `Skill("smithy.gh-issue")`.
2. Build the issue title from the `What diverges` text. Keep it concise and
   action-oriented, for example: `Close invariant drift: <What diverges>`.
3. Write the issue body to a temporary file using this template:

   ```markdown
   ## Drift

   Invariant: `<INV id>` — `<invariant title>`

   Divergence: `<What diverges>`

   Where: `<Where>`

   Disposition: `Temporary: <reason>`

   Severity: `<low|medium|high>`

   Establishing decisions: `<established_by ids>`

   ## Done When

   The divergence is removed or the invariant ledger is explicitly updated
   to show the team accepts the carve-out.
   ```

4. Invoke the `smithy.gh-issue` `create-issue.sh` script for the current
   agent with the title and temporary body file:

   ```bash
   ./.agents/skills/smithy.gh-issue/scripts/create-issue.sh "<title>" <temporary-body-file>
   ```

5. Parse the script output as JSON, capture the JSON `number`, format it as
   `#NNN`, and write `#NNN` into that new row's `Tracking Issue` cell.
   Clean up the temporary body file after the create attempt.

If any auth, network, script, or JSON parsing failure occurs, leave the newly
added `Temporary:` ledger row in place with its `Tracking Issue` cell as `—`.
Do not roll back the invariant edit. Capture the failure text and surface it in
the terminal summary after the engrave operation completes.

After patching the ledger, **recompute** `status` and patch the
frontmatter (`aligned` if zero `Temporary:` rows remain; `drifting`
otherwise). If the ledger ends up empty after a resolution, restore the
canonical em-dash placeholder row. Run Phase 7 before the commit.

Commit message:

```
engrave(invariant): <add|resolve> exception on <INV id> — <one-line summary>
```

---

## Phase 7: Project the engraved-knowledge pointer

After any successful Phase 3 create, Phase 4 update, Phase 5 supersede, or
Phase 6 exception edit have patched the engraved record files, and before the
terminal summary, refresh the managed pointer block in existing agent-context
files.

Projection is a final, best-effort phase. Warnings from this phase are
non-fatal: they do not roll back the record edit, do not fail the engrave or
supersede operation, and do not block the record commit. Include any successful
context-file projection edits in the same commit as the engraved record change.
If one target warns or fails, keep processing the other targets and report the
warning in the terminal summary.

### Projection targets

Candidate agent-context target files:

- `CLAUDE.md`
- `AGENTS.md`
- `.github/copilot-instructions.md`

Manage existing files only. Skip missing target files rather than creating
them; never create a new agent-context file just to add the projection block.

### Managed marker pair

The managed block is delimited exactly by this marker pair:

```markdown
<!-- smithy:engraved:begin -->
...
<!-- smithy:engraved:end -->
```

Only smithy may edit content between those markers. Never change hand-written
content outside the markers.

### Pointer content

Generate a pointer-only block. It lists engraved-knowledge directories present
in the repo plus an applicability note for future agents. It must not inline
record bodies and must contain no per-record index, per-record titles, or
enumeration of individual record files. Do not inline record bodies.

Discover these directory roots and include only the ones that exist, in this
deterministic order:

1. `docs/decisions/`
2. `docs/invariants/`
3. `docs/constitution/`
4. `docs/design/decisions/`
5. `docs/design/invariants/`
6. `docs/design/constitution/`

Render the block exactly from the discovered directory list so unchanged inputs
produce byte-identical, idempotent output on a second projection run. Use this
shape:

```markdown
<!-- smithy:engraved:begin -->
## Engraved Knowledge

This repository maintains engraved durable knowledge: decisions, invariants,
and principles. Before planning or making changes, read the applicable records
under these locations and judge whether they apply to the work at hand.

- docs/decisions/
- docs/invariants/
- docs/constitution/
<!-- smithy:engraved:end -->
```

The list above is illustrative; render only the present directories, preserving
the deterministic order.

### Marker handling

For each existing target file:

- **No markers**: append one fresh managed block at the end of the file. Preserve
  all existing prose before the appended block. If the file lacks a trailing
  newline, add one newline before the block.
- **Exactly one complete marker pair**: replace only the content from the begin
  marker through the end marker with the newly rendered block. Leave all bytes
  before the begin marker and after the end marker unchanged.
- **Malformed or duplicated markers**: emit a warning and leave that file unchanged.
  Do not guess where the block belongs.
- **No present engraved-knowledge directories**: render the markers and the
  applicability note with a short line saying no engraved-knowledge directories
  are present yet; keep the output deterministic.

Before committing, re-run the projection mentally against the same directory
inputs: if it would change a context file a second time, fix the rendering or
marker handling until a no-change projection re-run is byte-identical.

---

## Rules

- **One record per commit.** Exceptions: a Phase 5 supersession commit
  patches the new and old decision file together; a Phase 3a "create
  decision that also establishes an invariant" commit may include both
  files together.
- **Never rewrite an accepted or superseded decision body.** Decisions
  are append-only. To change the rule, supersede.
- **Never invent frontmatter fields** the per-kind tables above do not
  list. If a field is not in the schema, do not add it.
- **Always quote the title** in YAML frontmatter — `title: "<topic>"` —
  so titles containing `: ` survive the YAML parser.
- **The Known-Exceptions ledger column order is load-bearing.** Use
  `Where | What diverges | Disposition + Why | Tracking Issue | Severity`
  verbatim — the audit and parser depend on it.
- **Engraved records are NOT in `## Dependency Order` tables.** Do not
  add them to a parent artifact's table, and do not assign them an
  `M<N>` / `F<N>` / `US<N>` / `S<N>` ID.

---

## Output

After committing, print a one-line summary to the terminal:

```
Engraved <kind> <id> <title> at <path>
  status: <status>
  citations: <comma-separated edge summary, or "none">
```

For supersession, add a second line:

```
Superseded <old id> <old title>
```

For Phase 6 (exception edits), print the recomputed status and the
operation summary. When a `Temporary:` row was added, include a
`drift issue:` line — show `#NNN` if the drift-tracking issue was created, or
`not created — <failure summary>` if creation failed (the ledger row is kept
with `Tracking Issue: —`). Omit the line for `Accepted:` rows, resolutions,
removals, and conversions, which never create an issue:

```
Updated <INV id> ledger: <added|resolved> row "<Where>"
  status: <aligned|drifting>
  drift issue: <#NNN|not created — failure summary>
```
