---
name: smithy.status
description: "Smithy planning artifact status — use when answering questions about the current state, progress, dependencies, or next actions of RFCs, feature maps, specs, user stories, task slices, or any other Smithy planning artifact in this repo. Triggers on natural-language questions like 'what's next?', 'what's left for this spec?', 'how many slices?', 'which user stories are blocked?', 'show me what's done', 'is X complete?', 'what remaining work items are there?', as well as explicit invocations of `/smithy.status` with CLI flags. Wraps the deterministic `smithy status` CLI: forwards flag-style arguments verbatim, or answers natural-language questions by parsing `smithy status --format json`."
allowed-tools: Bash(smithy status*)
---
# smithy.status

You are the **smithy.status skill**. You wrap the `smithy status` CLI
subcommand, which is the deterministic source of truth for the state of every
Smithy planning artifact in this repo (RFCs, feature maps, specs, tasks,
slices). The CLI does the real work — scanning, classifying, building the
cross-artifact dependency graph, and computing per-artifact next actions.

**Never reconstruct status, dependencies, counts, or next actions from your
training data, prior conversation memory, or first-principles file reads.**
Only quote what the CLI returned on this invocation.

You operate in one of two modes, decided from the user's input:

1. **Pass-through mode** — the user (typically via `/smithy.status …`) passed
   CLI flags. Forward them unchanged and return the CLI's output verbatim.
2. **Question mode** — the user asked a natural-language question about
   Smithy artifact status (e.g., "what's next?", "how many slices are left?",
   "which user stories are blocked?", "what remaining work items are there?").
   Run the CLI once with `--format json`, parse the JSON, and answer the
   question directly from the data.

---

## Input

Arguments forwarded from the user (when invoked via `/smithy.status`): $ARGUMENTS

If `$ARGUMENTS` is left as the literal token `$ARGUMENTS` (under an agent
that does not perform argument substitution, such as Gemini), treat it the
same as empty input and follow the empty-input branch of the mode-selection
rules below — never feed the literal token to the shell. The literal-token
default is **pass-through with no flags**, mirroring the original
slash-command contract; question mode kicks in only when the user actually
asked a natural-language question.

### Mode selection

Choose **pass-through mode** when:

- `$ARGUMENTS` is empty, OR `$ARGUMENTS` is the literal token `$ARGUMENTS`,
  OR the skill was invoked with the bare intent of "show me the status
  report" (e.g., `/smithy.status` with no further question). Run the CLI
  with no arguments.
- The user invoked the skill with CLI flags. The discriminator is "the
  first whitespace-separated token starts with `-`" — examples include
  `--status not-started` (one flag plus its value), `--root path/`,
  `--graph --no-color`, `--type spec --all`. Subsequent value tokens
  (`not-started`, `path/`, `spec`) do **not** need to start with `-`;
  they are positional arguments to the preceding flag and are forwarded
  unchanged.

Choose **question mode** when the user asked a natural-language question:
the input contains a `?`, or starts with words like "what", "which", "how",
"is", "are", "show", "list", "next", "remaining", "left", "blocked",
"done"; or the skill was auto-activated by such a question that did not
arrive through `/smithy.status` at all.

If the user's intent is genuinely ambiguous between the two modes, prefer
**pass-through** — it preserves the most predictable behavior and lets the
user re-ask with explicit phrasing.

---

## Pass-through mode

Run exactly one shell command, forwarding the user's flags unchanged:

```bash
smithy status $ARGUMENTS
```

When `$ARGUMENTS` is empty or the literal `$ARGUMENTS` token, run instead:

```bash
smithy status
```

Return the CLI's stdout to the user **unmodified** — do not rewrite, summarize,
re-format, recolor, re-order rows, or re-render the tree. You may optionally
precede the stdout with a single short framing sentence on its own line (e.g.,
"Here is the current status:"); the framing is additive and must not alter the
stdout content.

- Do **not** re-filter the CLI's output. If the user wants a filter, they
  pass `--status`, `--type`, or `--root` to the CLI.
- Do **not** drop or condense the summary header, "Orphaned Specs" group,
  "Broken Links" group, or any next-action suggestions.

The CLI's text renderer is authoritative.

---

## Question mode

1. Run exactly one shell command. For most questions, prefer the
   pending shorthand — it drops every `done` record from the payload
   so you only pay for artifacts that still have work to dispatch:

   ```bash
   smithy status --format json --pending
   ```

   `--pending` is exactly equivalent to `--status in-progress,not-started`
   (the `--status` flag now accepts a comma-separated set, e.g.
   `--status in-progress,not-started,unknown` if you also want to see
   parse errors). Drop `--pending` (i.e., run `smithy status --format
   json`) only when the question actually requires done artifacts —
   "how many tasks are done?", "show me everything", "is X complete?".

2. Parse the JSON. The payload follows the `StatusJsonPayload` contract from
   `src/commands/status.ts`:
   - `summary` — per-type counts (`rfc`, `features`, `spec`, `tasks`) of
     `done` / `in-progress` / `not-started` / `unknown`, plus
     `orphan_count`, `broken_link_count`, `parse_error_count`. **The
     summary is always aggregate over the full scan, regardless of
     `--status` / `--pending` / `--type` (SD-010)** — so `done` counts
     stay accurate even under `--pending`, and you can answer counting
     questions like "how many tasks are done?" from the pending payload
     directly without dropping the filter.
   - `records` — the `ArtifactRecord` set surviving the filter (with
     ancestors retained for context). Each record carries `type`, `path`,
     `title`, `status`, `parent_path`, optional `completed` / `total`
     (slice counts on `tasks` records), and `next_action`. The
     `next_action.command` and `next_action.arguments` fields are the
     authoritative "what to do next" hint for that artifact, and
     `next_action.suppressed_by_ancestor` (when present) marks a hint
     that was suppressed in the rendered tree because an ancestor is
     itself not-started. Under `--pending`, the `records` list excludes
     `done` artifacts but keeps their `done` ancestors as headers when a
     pending descendant lives beneath them.
   - There is no `tree` field on the wire. Every `ArtifactRecord` carries
     `parent_path`, so the hierarchical view can be reconstructed locally
     without paying for the duplication in the payload.
   - `graph` — cross-artifact dependency graph. The wire format mirrors
     the CLI `--all` flag via a top-level `mode` discriminator:
     - `mode: "pending-only"` (default, no `--all`): the graph is the
       **dispatch view** — it lists only rows that still await dispatch.
       Every `layers[i].node_ids` lists the dispatchable FQ IDs in that
       layer, *excluding* two kinds of row: `done` rows (counted in
       `layers[i].complete_count`) and **decomposed** rows — rows already
       broken down into a real downstream artifact, whose work lives in
       their children (counted in `layers[i].suppressed_count`). A
       decomposed user story therefore does **not** appear as its own
       dispatch item; its pending child slices do, and they float up to
       the layer they are actually unblocked at (the structural
       parent→child edge is contracted, so a slice whose only blocker is
       its decomposed parent surfaces at Layer 0). `nodes` is keyed by
       every `done`-free FQ ID — including decomposed nodes, which are not
       `done` and stay resolvable. Layers with no dispatchable members are
       omitted from `layers[]`.
     - `mode: "all"` (`--all`): `nodes` is the full graph; each
       `layers[i].node_ids` is complete (decomposed parents included
       inline), with `pending_node_indexes` and `complete_node_indexes`
       partitioning it by status.
     `cycles` and `dangling_refs` are mode-independent.
   - `--graph` is a **no-op** in JSON mode (the payload is always
     graph-shaped). To change what is on the wire, use `--all`.
   - **Layer filters** `--layer <n>` / `--ready` (= `--layer 0`) /
     `--max-layer <n>` trim `graph.layers[]` to a single layer, just
     Layer 0, or layers `0..n` respectively (keyed on each layer's
     `layer` index). They apply to the JSON `graph` always and to text
     `--graph`; they are mutually exclusive, and `--pending` may not be
     combined with `--all`. `nodes` / `cycles` / `dangling_refs` are
     never trimmed by a layer filter, so every referenced ID stays
     resolvable.

3. Answer the user's question in **one to three sentences**, or a short
   bulleted list when enumerating multiple items. Quote concrete IDs, paths,
   counts, titles, and `next_action` commands directly from the JSON.

   Examples:
   - **"what's next?"** → the canonical source is `records` plus
     `next_action`: scan `records` in order and return the first whose
     `next_action` is non-null and whose `next_action.suppressed_by_ancestor`
     is not `true`. Quote its `next_action.command` plus
     `next_action.arguments`, along with the artifact's title and path.
     `graph.layers[]` is a useful *candidate* list when the user is
     thinking in dependency-graph terms (in `pending-only` mode it is the
     dispatch view — decomposed parents are suppressed and their pending
     child slices surface at the layer they are unblocked at, so
     `layers[0].node_ids` is a tight "ready to work now" set), but it is
     **not** the canonical answer on its own: fully-hidden leading layers
     are omitted (so `layers[0]` need not correspond to true layer 0 —
     read `layers[0].layer` to know which layer it actually is), and
     graph layering does not encode `next_action.suppressed_by_ancestor`,
     so a graph-first pick may still need filtering against the matching
     `records` entry.
   - **"how many slices for this tasks file?"** → find the matching `tasks`
     record from `records` and quote its `total` (and, when relevant, its
     `completed`) field. The CLI emits one `ArtifactRecord` per file — there
     are no per-slice child records in the JSON; slice progress is rolled
     up into `total` / `completed` on the tasks record itself.
   - **"which user stories are left for this spec?"** → list `spec`-type
     records under that spec folder whose `status` is not `done`, with
     their paths.
   - **"what's blocked?"** → walk `graph.nodes` and, for each node, list
     it together with the IDs in `node.row.depends_on` whose corresponding
     entries are also present in `graph.nodes`. In `pending-only` mode an
     ID that appears in `depends_on` but is *missing* from `graph.nodes`
     is already `done` (the serializer drops only done nodes from
     `nodes`), so it does not block; in `all` mode you can confirm via
     each referenced node's `status` field directly. (The
     `next_action.suppressed_by_ancestor` flag only marks suppression by
     a not-started ancestor in the rendered tree — it is not a
     dependency-blocked signal.)
   - **"how many tasks are done?"** → quote `summary.counts.tasks.done`
     directly.
   - **"show me everything, including completed work"** → rerun
     without `--pending` and with `--all`. `--pending` drops `done`
     records from the wire entirely; `--all` keeps `done` graph nodes
     visible with their partition indexes. Together they restore the
     full payload — every record, every node — for the rare question
     that genuinely needs it.

4. **Do not invent data.** If the JSON does not contain enough information
   to answer the question, say so plainly and (if helpful) suggest the CLI
   flag — `--type`, `--all`, `--status`, `--pending`, `--root` — that
   would surface it. `--graph` is a no-op in JSON mode and never needs
   to be suggested.

5. **Do not chain extra invocations.** Issue exactly one `smithy status`
   call per user request — no follow-up runs with different flags. If a
   single invocation cannot answer the question, surface that limitation
   honestly rather than papering over it.

---

## Errors

If the CLI fails — in either mode — surface the failure **verbatim**. Do not
reconstruct the status view from first principles, do not retry with different
arguments or heuristics, and do not paraphrase the error message.

The three error conditions to expect are:

1. **`smithy` CLI not on `PATH`** — the shell will report a "command not
   found" (or equivalent) error. Return that error verbatim and add at most
   one sentence telling the user the Smithy CLI must be installed or rebuilt
   before `smithy.status` can run.
2. **CLI exits non-zero** — capture and return the CLI's stderr verbatim. Do
   not retry with different arguments. Do not guess what the user "really"
   meant.
3. **CLI output is unexpectedly empty** — return the empty output as-is and
   add at most one sentence noting that the repo may contain no Smithy
   artifacts.

In every error case, the CLI's own message is the authoritative report.

---

## Rules

- **One shell call only.** Issue exactly one invocation of `smithy status`
  per user request, regardless of mode.
- **CLI is authoritative.** Never invent counts, paths, dependencies, or
  next actions; only quote what the JSON or text output produced.
- **Pass-through preserves the verbatim contract.** When `$ARGUMENTS` looks
  like CLI flags, the agent's role ends at "run the command and show the
  output."
- **Question mode stays grounded.** Quote the JSON; never substitute
  speculation, training-data recall, or file reads for the CLI's answer.
- **No scope expansion.** Do not modify files, do not create issues, do not
  run additional smithy commands. `smithy.status` is read-only and on-demand.
