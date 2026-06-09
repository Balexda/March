---
name: smithy.helper-flow-definition
description: "Schema and authoring rules for the durable Flow entity pair — `design/flows/<FlowId>.flow.md` (thin intent annotation) and a paired executable test body — keyed 1:1 by flat FlowId. Use when authoring or auditing a flow definition, when emitting a flow as part of a UI feature's wire phase (kind: ui, phase: wire), or when validating an existing flow stays thin and testID-keyed. Provides the YAML front-matter field schema (id / screens / test-body), the rationale-only body rule, the driver-neutral selector contract, the testID naming convention, a skeleton template, and a worked AddTitle example."
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

- Writing or updating a `<FlowId>.flow.md` + executable test-body pair for a
  `kind: ui` feature at `phase: wire`.
- Auditing an existing flow for drift, redundancy, fragile selectors, or
  step-leakage from the executable test body into prose.
- Emitting a flow as part of `forge`'s UI wire phase
  (EPIC #404 / issue #408).
- Validating cross-references during `flow-lint` (issue #409).

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
| `screens` | Yes | List of `ScreenId` the flow traverses, in entry order (e.g. `[Library, AddTitle]`). Each entry must appear in some feature's `screens:` field; cross-file resolution is enforced by `flow-lint` (#409). |
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

## Skeleton template

**`design/flows/<FlowId>.flow.md`:**

````markdown
---
id: <FlowId>
screens: [<ScreenId>, <ScreenId>]
test-body: <repo-relative path to the paired executable test body>
---

# Flow: <FlowId>

## Intent

<One short paragraph: the durable product truth this flow preserves. Why this
journey is worth a permanent test — not what the user taps.>

## Guards

- **<invariant>.** <Why it matters; the test body asserts it.>
- **<invariant>.** <Why it matters; the test body asserts it.>

## Entry / Exit

- **Enter from**: <surface and testID, e.g. Library screen, tap on `library-fab`>.
- **Exit on**: <terminal state and testID, e.g. tap `add-title-confirm-button`
  with a valid URL → return to Library list, new title visible>.

## Coverage Caveat

<What this flow does NOT observe — required whenever the screen touches an
audio-service surface. Audio-service behaviors (auto-advance under lock,
foreground TTS, audio-focus handling) need instrumentation-level tests.>
````

**Example `test-body` (`maestro/flows/<FlowId>.yaml`):**

```yaml
# Selectors are keyed to testIDs. Never visible text, never layout position.
appId: <reverse-domain.app.id>
---
- launchApp
- assertVisible:
    id: "<entry-test-id>"
- tapOn:
    id: "<entry-test-id>"
- assertVisible:
    id: "<arrived-test-id>"
# Guard: <invariant from flow.md Guards section>.
- assertNotVisible:
    id: "<guarded-state-test-id>"
- tapOn:
    id: "<field-test-id>"
- inputText: "<...>"
# Guard: <invariant becomes reachable once preconditions hold>.
- assertVisible:
    id: "<guarded-state-test-id>"
- tapOn:
    id: "<confirm-test-id>"
- assertVisible:
    id: "<exit-test-id>"
```

---

## Worked example — `AddTitle.flow.md` and a Maestro `AddTitle.yaml`

**`design/flows/AddTitle.flow.md`:**

````markdown
---
id: AddTitle
screens: [Library, AddTitle]
test-body: maestro/flows/AddTitle.yaml
---

# Flow: AddTitle

## Intent

A user adds a new title to their library by tapping the Library FAB, filling
the title and URL fields, and confirming. The flow exists to lock in the
durable truth that adding a title is reachable from the library home in one
tap and returns the user to a list with their new title visible. If this
journey ever breaks, the product breaks — there is no library without it.

## Guards

- **Confirm is disabled until the URL is valid.** The URL field is the only
  required input the store cannot recover from; a permissive Confirm would
  silently persist garbage.
- **Submitting a duplicate URL is a no-op.** Duplicate detection lives in the
  store, but the user-visible contract is "no second row appears" — the
  flow asserts that surface so a regression that breaks dedup is caught.
- **The back gesture returns to Library without persisting partial input.**
  Half-filled rows would corrupt the library; the back-out path must drop
  the draft.

## Entry / Exit

- **Enter from**: Library screen, tap on `library-fab`.
- **Exit on**: tap `add-title-confirm-button-enabled` with a valid URL →
  return to Library list, new title visible at the top of `library-list`.

## Coverage Caveat

This flow asserts navigable bookends only. It does **not** cover:

- Auto-advance to the next title under the lock screen.
- Foreground TTS service playback.
- Audio focus handling on incoming calls.

Those behaviors live below what a UI driver can observe and must be covered
by instrumentation-level tests. **A green Maestro run must not be read as
TTS coverage.**
````

**`maestro/flows/AddTitle.yaml`:**

```yaml
# Selectors are keyed to testIDs. Never visible text, never layout position.
appId: com.storyspider.app
---
- launchApp
- assertVisible:
    id: "library-fab"
- tapOn:
    id: "library-fab"
- assertVisible:
    id: "add-title-title-field"
- assertVisible:
    id: "add-title-url-field"
# Guard: confirm is disabled until the URL is valid.
- assertNotVisible:
    id: "add-title-confirm-button-enabled"
- tapOn:
    id: "add-title-title-field"
- inputText: "The Magic Circle"
- tapOn:
    id: "add-title-url-field"
- inputText: "https://example.com/magic-circle.mp3"
# Guard: with a valid URL, confirm becomes reachable.
- assertVisible:
    id: "add-title-confirm-button-enabled"
- tapOn:
    id: "add-title-confirm-button-enabled"
- assertVisible:
    id: "library-list"
- assertVisible:
    id: "library-row-the-magic-circle"
```

Note what is *not* in the `.flow.md` body: no list of taps, no screen
transitions, no copy strings, no per-step screenshots. Note what *is* in
the executable test body: not just the happy path, but the `assertNotVisible` →
`assertVisible` pair around `add-title-confirm-button-enabled` that proves
the URL guard fires. The example uses Maestro yaml because that is Story
Spider's driver; it is illustrative, not required by the schema.

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
- **No `feature:` or `kind:` field on the flow.** Feature membership is
  declared on the originating feature in `.features.md` via
  `flows: [FlowId]`; duplicating it here would create two places to
  update.

---

## Coverage caveat — applies to every audio-touching flow

UI-driver flow tests cover **navigable bookends** — what a UI driver can
observe by tapping/activating controls, asserting visibility, and reading
testID-keyed views. Maestro yaml is one example of such a test body.
**Audio-service behaviors** (auto-advance under lock, foreground TTS,
audio-focus handling) sit below that layer; their durable body is
**instrumentation-level tests**, not the UI-driver flow body.
**A green UI-driver run must not be read as TTS coverage.** Every `.flow.md`
that touches an audio-service surface states this caveat explicitly under
`## Coverage Caveat` so reviewers don't infer coverage that isn't there.

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
- [ ] `screens:` references a `ScreenId` that no feature declares.
- [ ] `.flow.md` body contains a `## Steps`, `## Walkthrough`, `## Flow`,
      or `## Path` section.
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
