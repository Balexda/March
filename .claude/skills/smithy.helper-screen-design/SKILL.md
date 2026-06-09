---
name: smithy.helper-screen-design
description: "Schema and authoring rules for `design/screens/<ScreenId>.design.md` — the thin durable intent annotation that colocates with a UI screen's component body. Use when authoring or auditing a screen design-context annotation, when emitting a screen as part of a UI feature (kind: ui), or when validating that an existing annotation stays thin. Provides the YAML front-matter field schema (id / component-path / design_system / bundle), the rationale-only body rule, a skeleton template, and a worked Library example."
---
# smithy.helper-screen-design

Authoring contract for the thin durable annotation that carries a UI screen's
*intent*. The UI component is the screen's body; the `<ScreenId>.design.md`
file at `design/screens/<ScreenId>.design.md` (in the **app repo**, alongside
the code) is metadata *about* that body — why the screen exists, what was
deliberately chosen, what was deferred. Load this skill when:

- Writing a new `<ScreenId>.design.md` for a `kind: ui` feature.
- Auditing an existing annotation for drift, redundancy, or layout
  re-description.
- Emitting a screen annotation as part of `forge`'s UI build phase
  (EPIC #404 / issue #408).
- Validating cross-references during `flow-lint` (issue #409).

Do **not** load this skill for backend features or for general voice/audience
prose work — `smithy.helper-voice` covers the latter, and `kind: backend`
features have no screen artifact at all.

---

## Why a thin annotation (not a screen spec)

The "third lifetime" question for UI work — *what is durable about a screen?*
— resolves to: **the component body**. Every spec we could write about layout,
structure, or steps is either already encoded in the project framework's
component or destined to drift against it. So the durable artifact is rationale
only:

- **The component owns layout, structure, and behavior** (verified by the
  bundle when present, the design skill always, and the executable flow body
  at `wire`).
- **The `.design.md` owns intent** — the product reason, the choices, the
  non-decisions — colocated with the code so neither moves without the
  other.

If a contributor can rebuild the screen by reading the `.design.md`, the
file is wrong. If they can explain *why the screen looks the way it does*
from reading it, the file is right.

---

## YAML front-matter schema

Every `<ScreenId>.design.md` opens with YAML front-matter between `---`
fences. Four keys, three required:

| Key | Required | Notes |
|-----|----------|-------|
| `id` | Yes | Flat, stable `ScreenId`. Matches the `screens:` list of the originating UI feature in `.features.md`; never reused across screens. |
| `component-path` | Yes | Repo-relative path to the owning UI component file in the project's framework (for example a Compose file such as `app/src/main/kotlin/io/balexda/readercompose/ui/views/library/LibraryScreen.kt`, or a React component such as `src/screens/LibraryScreen.tsx`). Paths survive package/module renames; the path is the contract, not a framework-specific symbol name. |
| `design_system` | Yes | Reference to the committed design skill (e.g. `story-spider-design`). Source of truth even when a `bundle` is present — bundle wins on layout & visual intent, skill wins on implementation dialect. |
| `bundle` | No | Repo-relative path to the originating Claude Design export (e.g. `design/bundles/library.zip`). A visual/structural reference, not a drop-in. Omit the key entirely when no bundle exists — do not set it to `null` or an empty string. |

No other keys. In particular, **no `flows:` field here** — flow membership is
declared on the originating feature in `.features.md`; duplicating it on the
screen would create two places to update.

---

## Body shape — three rationale-only sections

The body is rationale only, organized under three `##` sections in this
order:

| Section | What goes here | What does *not* go here |
|---------|----------------|--------------------------|
| `## Why this screen exists` | The product reason this screen owns space — one short paragraph. | Anything about how it looks. |
| `## Deliberate choices` | Decisions a future contributor (or `forge`) would otherwise re-litigate (list vs. grid, FAB vs. app-bar action, empty-state weight). State the choice **and the why**. | Step-by-step descriptions, pixel-level layout, copy text. |
| `## Deferred` | Things this screen explicitly does *not* do, with enough context that they don't get reinvented. | Backlog grooming for other screens. |

There is **no `## Layout`, `## States`, or `## Flow` section.** The component
and the executable flow body (at `wire`) own those. If you find yourself typing
"the top of the screen contains…" — stop. That belongs in the component or the
bundle, not here. No layout description, no step-by-step walkthrough, no copy
strings, no state-machine diagrams.

---

## Skeleton template

````markdown
---
id: <ScreenId>
component-path: <repo-relative path to the owning UI component file>
design_system: <committed design skill, e.g. story-spider-design>
bundle: <repo-relative path to the Claude Design export, or omit the key>
---

# <ScreenId> — design context

## Why this screen exists

<One short paragraph: the product reason this screen owns space. Not what it
looks like — why it is here at all.>

## Deliberate choices

- **<choice>.** <Why we picked it over the obvious alternative.>
- **<choice>.** <Why we picked it over the obvious alternative.>

## Deferred

- **<thing not done>.** <Why we left it out and what would unblock it.>
````

---

## Worked example — `Library.design.md`

````markdown
---
id: Library
component-path: app/src/main/kotlin/io/balexda/readercompose/ui/views/library/LibraryScreen.kt
design_system: story-spider-design
bundle: design/bundles/library.zip
---

# Library — design context

## Why this screen exists

The Library is Story Spider's home base — the first surface a returning
reader sees, listing every title they have added so far. Anchoring the home
tab here (rather than a "Now Reading" continuation) keeps the model simple
while the library is small and keeps the "add a new title" action one tap
from the launcher.

## Deliberate choices

- **List, not grid.** Titles are URLs with long names; a single-column list
  shows the full name without truncation. The lower information density is
  the intended trade.
- **FAB for "add title."** The primary add action is a FAB rather than an
  app-bar action because it is the only affordance that drives growth of
  the library — biasing visual weight toward it is intentional.
- **Empty state owns the screen.** Before any titles exist, the empty state
  is the full content area (illustration + one-sentence value prop + the
  same add-title affordance the FAB triggers), not a footnote under an
  empty list.

## Deferred

- **Sorting / filtering.** Insertion order only for now; sorting waits
  until the library is plausibly large enough to need it (and a real user
  asks).
- **Per-title artwork.** The bundle shows placeholder thumbnails; real
  artwork is downstream of the metadata-extraction feature, not this
  screen.
- **Multi-select / bulk delete.** Out of scope until we have a story for
  why someone would remove titles in bulk; single-item swipe-to-delete is
  sufficient at current scale.
````

Note what is *not* in the example: no list-row anatomy, no FAB position, no
copy strings, no state-machine diagram. All of those belong in the
component (or, for navigation, the executable flow body at `wire`). The
example uses a Compose component path because that is Story Spider's stack;
it is illustrative, not required by the schema.

---

## Naming decisions

- **`id` is flat**, matching the rest of the repo-resident UI graph
  (`ScreenId`, `FlowId`). The repo is the namespace; no scoping prefix,
  no path-encoded hierarchy.
- **`component-path` is a path, not a framework-specific symbol name.** Paths
  survive package/module renames; fully-qualified Kotlin names, exported React
  symbols, Swift type names, and equivalent framework identifiers do not.
- **`design_system` is the *committed skill*, not the bundle.** A bundle
  is optional and per-screen; the skill is the foundation and applies
  even when no bundle exists, so it owns the source-of-truth slot.
- **No `flows:` field on the screen.** Flow membership is declared on the
  originating feature; duplicating it here would create two places to
  update.

---

## Review checklist

When auditing an existing `<ScreenId>.design.md`, flag any of the
following:

- [ ] Missing required front-matter key (`id`, `component-path`,
      `design_system`).
- [ ] `component-path:` path does not resolve to an existing file in the repo.
- [ ] `id` does not match the feature's `screens:` list, or is reused
      across screens.
- [ ] `design_system:` empty even when a `bundle:` is set (bundle without
      skill is invalid — skill is source of truth).
- [ ] Body contains a `## Layout`, `## States`, `## Flow`, `## Steps`, or
      `## Walkthrough` section.
- [ ] "Deliberate choices" describes what the screen looks like instead of
      why the choice was made.
- [ ] "Deferred" lists items that belong to a different screen or
      feature.
- [ ] Bundle path set but file does not exist (or vice versa — bundle file
      present but key omitted).

Surface each as a finding for the parent command (`smithy.forge` review
pass, `smithy.audit`, or `flow-lint`) to act on. This skill itself does not
modify files.
