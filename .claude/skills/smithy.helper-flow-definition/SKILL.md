---
name: smithy.helper-flow-definition
description: "Schema and authoring rules for the durable Flow entity pair — `design/flows/<FlowId>.flow.md` and its paired executable <test-body>. Use when authoring or auditing a flow definition, when emitting a flow artifact and stub test body for a UI feature's wire phase (kind: ui, phase: wire), or when checking an existing flow stays thin and testID-keyed."
---
# smithy.helper-flow-definition

Authoring contract for the durable representation of a UI **flow** — a path a
user can take through the app that the team commits to preserving. A flow is
represented by a **1:1 pair** keyed by a flat `FlowId`:

```
design/flows/<FlowId>.flow.md      # durable INTENT annotation (why)
<test-body>                        # durable BEHAVIORAL body (what runs)
```

Both files live in the **app repo**, alongside the code, not in Smithy. Load
this skill when:

- Writing a `<FlowId>.flow.md` + placeholder test-body pair from `smithy.mark`
  for a `kind: ui` feature at `phase: wire`, or updating the executable
  behavior in that existing test body downstream.
- Auditing an existing flow for drift, redundancy, fragile selectors, or
  step-leakage from the executable test body into prose.
- Emitting a mark-owned flow artifact and paired stub test body for a UI wire
  feature.
- Validating cross-references during `flow-lint`.

Do **not** load this skill for backend features, for screen-only work
(`smithy.helper-screen-design` covers screens), or for general prose work
(`smithy.helper-voice`). `kind: backend` features and `phase: build` UI
features have no flow artifact at all — flows are only emitted at `wire`.

---

## Why a thin annotation + an executable body (not a single spec)

The "third lifetime" question for flows — *what is durable about a user
journey?* — resolves to: **the executable test body**. Every spec we could
write that re-narrates the path in prose is either already encoded in the
project's UI-driver test file or destined to drift against it. So the pair
splits cleanly:

- **The executable test body owns behavior** — the actual actions, asserts,
  and guards a UI driver replays. It is the executable proof that the journey
  still works.
- **The `.flow.md` owns intent** — *why* the flow is a durable truth, *why*
  the guards exist, where the user comes from and where they end up, and
  what the UI driver cannot cover. Colocated with the design folder so
  neither half moves without the other.

If a contributor can replay the journey by reading the `.flow.md`, the file
is wrong (those steps belong in the executable test body). If the test body
lists actions but asserts no guards, the test body is wrong (it has regressed
to a smoke test). The pair stays honest only when each file owns its lane.

---

## YAML front-matter schema

Every `<FlowId>.flow.md` opens with YAML front-matter between `---` fences.
Three keys, all required:

| Key | Required | Notes |
|-----|----------|-------|
| `id` | Yes | Flat, stable `FlowId` (e.g. `AddTitle`). Matches the `.flow.md` filename stem and the paired executable test body named by `test-body`, plus the `flows:` list of the originating UI feature in `.features.md`. Never reused across flows. |
| `screens` | Yes | List of `ScreenId` the flow traverses, in entry order (e.g. `[Library, AddTitle]`). Each entry must appear in some feature's `screens:` field; cross-file resolution is enforced by `flow-lint`. |
| `test-body` | Yes | Repo-relative path to the paired executable test body in the project's UI driver (for example `maestro/flows/AddTitle.yaml` for Maestro, or `tests/e2e/add-title.spec.ts` for Playwright/Cypress). The path is the contract; renaming the test without updating this field is a `flow-lint` failure. |

No other keys. In particular, **no `feature:` or `kind:` field here** — flow
membership is declared on the originating feature in `.features.md`;
duplicating it on the flow would create two places to update.

---

## Body shape — three rationale-only sections plus the coverage caveat

The `.flow.md` body is rationale only, organized under three `##` sections
in this order, followed by a mandatory coverage caveat:

| Section | What goes here | What does *not* go here |
|---------|----------------|--------------------------|
| `## Intent` | The durable product truth this flow preserves — one short paragraph. *Why* this journey is worth a permanent test. | Step descriptions, taps, screen transitions. |
| `## Guards` | The guarantees that must hold along the path, stated as invariants the executable test body asserts (e.g. "Confirm is disabled until the URL is valid"). State the invariant **and the why**. | The test lines that check them — those live in the test body. |
| `## Entry / Exit` | Where the user enters from (the testID or surface that starts the flow) and where they end up. Two short bullets. | The intermediate steps. |
| `## Coverage Caveat` | What this UI-driver flow does **not** observe (audio-service behaviors, background work, anything below the UI driver). Mandatory whenever the screen touches an audio surface. | Aspirational coverage; coverage lives where the test does. |

UI-driver flows cover **navigable bookends** — what a driver can observe by
activating controls, asserting visibility, and reading testID-keyed views.
Audio-service behaviors (auto-advance under lock, foreground TTS,
audio-focus handling) sit below that layer and are durable only as
instrumentation-level tests, so
**a green UI-driver run must not be read as TTS coverage.**
That is what the `## Coverage Caveat` section exists to say out loud, on
every flow that touches an audio surface, so reviewers don't infer coverage
that isn't there.

There is **no `## Steps`, `## Walkthrough`, `## Flow`, or `## Path` section.**
The executable test body owns the steps. If you find yourself typing "the user
taps the FAB, then the AddTitle screen appears, then…" — stop. That belongs
in the executable test body, not here. No tap-by-tap walkthroughs, no copy
strings, no per-step screenshots.

---

## Executable test-body contract

The test body is the executable behavioral body. It uses the project's UI test
driver; Maestro yaml is one valid example, not the required format. Three
load-bearing rules:

1. **1:1 with `FlowId`.** One flow = one executable test body. Variants that
   earn a durable name earn their own `FlowId`; never fold multiple paths
   ("happy + error path") into one test body.
2. **Selectors are keyed to testIDs, accessibility IDs, or semantic tags —
   never visible text and never layout position.** Flow tests must fail
   on *path* changes (a tap moved, a guard removed, a screen reordered)
   and survive *visual* changes (copy edits, palette swaps, spacing
   tweaks). Visual iteration happens upstream on the design canvas, not
   here.
3. **Assert the traversal AND the guards.** A test body that only walks the
   happy path provides no durability — the guard assertions (`cannot reach
   confirm without a valid URL`) are what catch path regressions. Every guard
   named in the `.flow.md` body must have at least one corresponding assertion
   in the test body.

---

## testID naming convention

UI components expose stable test IDs so the executable test body can key off
them:

- **kebab-case**, ASCII-lowercase, hyphens only. No camelCase, no
  underscores, no spaces.
- **`<scope>-<element>[-<modifier>]`** structure:
  - **`<scope>`** — the screen, flow, or area the element belongs to
    (`library`, `add-title`, `player`, `settings`).
  - **`<element>`** — the semantic role of the control (`fab`, `field`,
    `button`, `confirm`, `back`, `list`, `row`).
  - **`<modifier>`** — when the element has multiple instances on the
    same scope, the specific field or state (`title-field`, `url-field`,
    `confirm-button-enabled`, `row-<title-slug>`).
- **Stable across rewrites.** A testID is part of the screen's public
  surface. Renaming a testID is a breaking change to every flow that
  references it — treat it like an API rename.
- **Never derived from visible text** (so copy edits don't break flows)
  and **never derived from layout position** (so reordering doesn't
  break flows).

| testID | What it identifies |
|--------|-------------------|
| `library-fab` | Floating action button on the Library screen. |
| `add-title-title-field` | Title input field on the AddTitle screen. |
| `add-title-url-field` | URL input field on the AddTitle screen. |
| `add-title-confirm-button` | Confirm button on the AddTitle screen. |
| `add-title-confirm-button-enabled` | Confirm button in its enabled state (used to assert the URL guard). |
| `library-list` | The list container on the Library screen. |
| `library-row-<title-slug>` | A specific row in the Library list, keyed by the title slug. |

---

## Skeletons and worked example

Copy-ready skeletons for both halves of the pair, plus a filled-in
`AddTitle` example (flow annotation + Maestro test body), live in
[`references/examples.md`](references/examples.md). Read that file when you
are writing a new pair or want a concrete shape to compare an existing one
against; the schema and body rules above are the authority.

---

## Naming decisions

- **`id` is flat**, matching `ScreenId` and the rest of the repo-resident
  UI graph. The repo is the namespace; no scoping prefix, no
  path-encoded hierarchy. `FlowId`s are never reused.
- **`screens` is a list, in entry order.** A flow traverses more than one
  screen (that's what makes it a flow); listing them in entry order
  makes the resolution at `flow-lint` time deterministic.
- **`test-body` is a path, not a derived convention or driver-specific field.**
  Renaming the executable test without updating the field is a `flow-lint`
  failure — the path is the contract, not a derived guess.

---

## Don't over-apply

Reserve executable flow bodies for **long-lived product truths** (Library add,
read, TTS auto-advance). Marginal paths stay prose until they prove
load-bearing. The cost of a flow is the maintenance commitment to its
`.flow.md` + test-body pair forever — only pay it for journeys you would
refuse to ship a release that broke.

---

## Review checklist

When auditing an existing flow pair, flag any of the following:

- [ ] Missing required front-matter key in `.flow.md` (`id`, `screens`,
      `test-body`).
- [ ] `test-body:` path does not resolve to an existing file in the repo.
- [ ] `id` does not match the originating feature's `flows:` list, or is
      reused across flows.
- [ ] `screens:` is empty, not a list, contains non-string values, or
      references a `ScreenId` with no matching
      `design/screens/<ScreenId>.design.md` annotation. A direct review of
      this pair checks only that each referenced annotation file **exists**;
      whether that `ScreenId` is declared by some feature — and the rest of
      the screen/flow/test graph — stays with `flow-lint`.
- [ ] `.flow.md` body contains a `## Steps`, `## Walkthrough`, `## Flow`,
      or `## Path` section.
- [ ] `.flow.md` body contains click/tap sequences, selectors, assertions,
      driver-specific test code, or other executable behavior that belongs in
      the paired test body.
- [ ] `## Guards` lists invariants the test body does **not** assert.
- [ ] `## Coverage Caveat` is missing on a flow whose screen touches an
      audio-service surface.
- [ ] Executable test body uses visible-text matchers or layout-index
      selectors instead of testIDs / accessibility IDs / semantic tags.
- [ ] Executable test body asserts only the happy path (no negative-state or
      guard check anywhere) — guards must be testable, not just narrated.
- [ ] testID referenced in the test body does not follow
      `<scope>-<element>[-<modifier>]` kebab-case naming.
- [ ] Two test bodies share one `FlowId`, or one `FlowId` has no matching
      test body.

Surface each as a finding for the parent command (`smithy.forge` review
pass, `smithy.audit`, or `flow-lint`) to act on. This skill itself does
not modify files.
