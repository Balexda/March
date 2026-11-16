# Skeletons and a worked flow pair

Templates to copy and a filled-in example to pattern-match against. The
schema and the body rules these follow are in `SKILL.md`; read that first
and treat it as authoritative if the two ever disagree.

## Skeleton — `design/flows/<FlowId>.flow.md`

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

## Skeleton — `test-body` (Maestro shown; any UI driver applies)

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

## Worked example — `design/flows/AddTitle.flow.md`

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

## Worked example — `maestro/flows/AddTitle.yaml`

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
