# Worked before/after examples

Three transformations showing the taxonomy applied. Load this file when you
want a pattern to match against; the rules themselves are in `SKILL.md`.

## (a) Wordy / depth-first Motivation

**Before** — Stakeholder×Explanation drifting into Builder×Reference:

> The current system has a number of issues. The manual reconciliation
> between three config files takes about an hour each sprint. The
> reconciliation script is written in bash and uses `jq` to diff the
> JSON, which is brittle when fields are added. Specifically, the
> `services.yaml` file has a `replicas` field that defaults to 1, but
> some teams override it to 3 in their staging branch...

**After** — stays in Stakeholder×Explanation:

> Each sprint, teams lose roughly an hour reconciling three config
> files by hand. The brittleness compounds as the team scales: every
> new service multiplies the diff surface, and three P1 incidents last
> quarter traced back to drift the manual process missed.

The `jq` script and the `replicas` field belong in a child Reference
section, not in the Motivation.

## (b) Commingled Requirements section

**Before** — Reviewer×Explanation mixed with Builder×Reference+ai-input:

> Users should be able to see status across all artifacts. The CLI must
> emit JSON with a `nodes[]` array where each node has `id`, `kind`,
> `state`, `path`. Reviewers will want to confirm the JSON shape is
> stable before we wire status into CI.

**After** — split into two sections, each governed by its own template
voice spec (shown inline below for the reader's benefit; in real Smithy
artifacts the specs live in the template, not in the rendered file):

```
## Goals
<!-- audience: reviewer; mode: explanation; length: 1-2 paragraphs; diagram: optional; examples: discouraged -->

Users should be able to see status across all artifacts in one place,
stable enough to wire into CI.

## Status JSON Schema
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: recommended; examples: required -->

| Field | Type | Description |
|-------|------|-------------|
| `id`   | string | Canonical artifact ID |
| `kind` | enum   | `rfc` \| `spec` \| `tasks` |
| `state`| enum   | `pending` \| `done` |
| `path` | string | Repo-relative path |
```

## (c) Dense-prose `.contracts.md` that should have been signatures or N/A

**Before** — Reference mode emitting Explanation prose:

> The voice helper skill exposes two operations to its callers. The
> first, draft mode, takes an idea and a target audience and returns
> prose. The second, review mode, takes an existing artifact and
> returns a revised version. Internally, the skill does not make any
> function calls; it is a body of guidance the calling agent reads.

**After option 1** — compress to a signature table:

| Operation | Input | Output |
|-----------|-------|--------|
| draft  | section assignment, audience, length budget | prose |
| review | existing artifact path                      | revised artifact + findings |

**After option 2** — mark `N/A` if no code-shaped contract:

> N/A — `smithy.helper-voice` is a prose-only skill; it exposes no
> function or CLI surface for other agents to call.
