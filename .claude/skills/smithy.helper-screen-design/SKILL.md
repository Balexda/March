---
name: smithy.helper-screen-design
description: "Schema and authoring rules for `design/screens/<ScreenId>.design.md`, the thin durable intent annotation colocated with a UI screen's component body. Use when authoring or auditing a screen design-context annotation, when emitting a screen as part of a UI feature (kind: ui), or when checking an existing annotation stays thin."
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
- Emitting a screen annotation from `smithy.mark` for a UI feature's typed
  ledger.
- Validating cross-references during `flow-lint`.

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
| `design_system` | Yes | Reference to the committed design skill (e.g. `story-spider-design`). Source of truth even when a `bundle` is present — bundle wins on layout & visual intent, skill wins on implementation dialect. A screen with a `bundle` is invalid without `design_system`. |
| `bundle` | No | Repo-relative path to the originating visual prototype boundary object (for example a Figma export, Claude Design export, or equivalent visual-tool bundle). A visual/structural reference, not a drop-in. Omit the key entirely when no bundle exists — do not set it to `null` or an empty string. |

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

## Skeleton and worked example

A copy-ready skeleton plus a filled-in `Library` example live in
[`references/examples.md`](references/examples.md). Read that file when you
are writing a new annotation or want a concrete shape to compare an existing
one against; the schema and body rules above are the authority.

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
- [ ] Body contains a state inventory or visual-fidelity critique instead of
      rationale-only intent.
- [ ] "Deliberate choices" describes what the screen looks like instead of
      why the choice was made.
- [ ] "Deferred" lists items that belong to a different screen or
      feature.
- [ ] Bundle path set but file does not exist (or vice versa — bundle file
      present but key omitted).

Surface each as a finding for the parent command (`smithy.forge` review
pass, `smithy.audit`, or `flow-lint`) to act on. This skill itself does not
modify files.
