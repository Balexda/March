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

1. Run exactly one shell command:

   ```bash
   smithy status --format json
   ```

2. Parse the JSON. The payload follows the `StatusJsonPayload` contract from
   `src/commands/status.ts`:
   - `summary` — per-type counts (`rfc`, `features`, `spec`, `tasks`) of
     `done` / `in-progress` / `not-started` / `unknown`, plus
     `orphan_count`, `broken_link_count`, `parse_error_count`.
   - `records` — every `ArtifactRecord` discovered, with `type`, `path`,
     `title`, `status`, `parent_path`, optional `completed` / `total`
     (slice counts on `tasks` records), and `next_action`. The
     `next_action.command` and `next_action.arguments` fields are the
     authoritative "what to do next" hint for that artifact, and
     `next_action.suppressed_by_ancestor` (when present) marks a hint that
     was suppressed in the rendered tree because an ancestor is itself
     not-started.
   - `tree` — hierarchical view (`roots: TreeNode[]`).
   - `graph` — cross-artifact dependency graph with `nodes`, `layers`
     (topological), `cycles`, and `dangling_refs`.

3. Answer the user's question in **one to three sentences**, or a short
   bulleted list when enumerating multiple items. Quote concrete IDs, paths,
   counts, titles, and `next_action` commands directly from the JSON.

   Examples:
   - **"what's next?"** → cite the first actionable record from the lowest
     non-empty `graph.layers[]` (or scan `records` in order, picking the
     first whose `next_action` is non-null and `next_action.suppressed_by_ancestor`
     is not `true`). Return its `next_action.command` plus
     `next_action.arguments`, along with the artifact's title and path.
   - **"how many slices for this tasks file?"** → find the matching `tasks`
     record from `records` and quote its `total` (and, when relevant, its
     `completed`) field. The CLI emits one `ArtifactRecord` per file — there
     are no per-slice child records in the JSON; slice progress is rolled
     up into `total` / `completed` on the tasks record itself.
   - **"which user stories are left for this spec?"** → list `spec`-type
     records under that spec folder whose `status` is not `done`, with
     their paths.
   - **"what's blocked?"** → walk `graph.nodes` and, for each node whose
     owning record is not yet `done`, list it together with the IDs in
     `node.row.depends_on` whose corresponding nodes still have a non-`done`
     `status`. Those `depends_on` IDs are the actual blockers. (The
     `next_action.suppressed_by_ancestor` flag only marks suppression by a
     not-started ancestor in the rendered tree — it is not a
     dependency-blocked signal.)
   - **"how many tasks are done?"** → quote `summary.counts.tasks.done`
     directly.

4. **Do not invent data.** If the JSON does not contain enough information
   to answer the question, say so plainly and (if helpful) suggest the CLI
   flag — `--graph`, `--type`, `--all`, `--root` — that would surface it.

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
