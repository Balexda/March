# Skeleton and a worked screen annotation

A template to copy and a filled-in example to pattern-match against. The
schema and the body rules these follow are in `SKILL.md`; read that first
and treat it as authoritative if the two ever disagree.

## Skeleton — `design/screens/<ScreenId>.design.md`

````markdown
---
id: <ScreenId>
component-path: <repo-relative path to the owning UI component file>
design_system: <committed design skill, e.g. story-spider-design>
bundle: <repo-relative path to the visual prototype boundary object, or omit the key>
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
