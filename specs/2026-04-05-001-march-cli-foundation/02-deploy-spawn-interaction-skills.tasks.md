# Tasks: Deploy Spawn-Interaction Skills

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 2
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 02

---

## Slice 1: Verify Claude Code Discoverability Format

**Goal**: Add targeted tests to `skills.test.ts` that assert the skill definitions meet Claude Code's format requirements for slash-command and prompt discovery, closing Acceptance Scenario 3.

**Justification**: Acceptance Scenarios 1 and 2 (placeholder files deployed; all manifest paths exist on disk) are already satisfied by User Story 1 Slice 3, which explicitly claimed them. The spec governs US2 as deploying placeholder files — the content is correct as-is and must not change here. AS3 ("skills are discoverable by the AI agent as commands or prompts") is the unique contribution of this story. Claude Code discovers commands by scanning `~/.claude/commands/*.md` using the filename minus `.md` as the slash command name; prompts work the same way in `~/.claude/prompts/`. The existing test on line 24 of `skills.test.ts` permits arbitrary characters in filenames (`/^march\..*\.md$/`), which would allow names with spaces or uppercase letters that break Claude Code discovery. Line 70 only checks that `#` appears somewhere in content rather than that content opens with an H1. These two gaps are what this slice closes.

**Addresses**: FR-002 (partial — deployment already done; this slice validates format compliance); FR-012 (march. prefix — strengthens existing filename test); Acceptance Scenario US2-3

### Tasks

- [x] In `src/skills.test.ts`, replace the loose filename pattern test on line 24 (`/^march\..*\.md$/`) with a strict Claude Code-compatible pattern: `/^march\.[a-z0-9-]+\.md$/`. This ensures filenames produce valid slash command names (no spaces, no uppercase, no special characters beyond the hyphen already used in `spawn-dispatch`, `spawn-status`, and `output-handling`).
- [ ] In `src/skills.test.ts`, add a test "each skill content opens with an H1 heading" that checks `skill.content.trimStart().startsWith("# ")` for all skills. This is stronger than the existing `toContain("#")` check on line 70 and directly maps to what Claude Code renders as the command title.
- [ ] Run `npm test` and verify all tests pass, including the three per-skill title tests on lines 74–93 that assert placeholder content — those tests are correct for this milestone and must continue to pass.

**PR Outcome**: `skills.test.ts` encodes Claude Code's discoverability format requirements as executable assertions. Any future skill definition that uses a non-discoverable filename or omits the required H1 heading will fail CI.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — self-contained; only `skills.test.ts` changes.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Initialize March Environment | depends on | US1 Slice 3 delivered the deployment mechanism, the `MarchSkill` interface, and the placeholder skill content this story validates. No changes to `skills.ts` or `init.ts` are made here. |
| User Story 3: Update March Installation | depended upon by | US3's `march update` redeploys skills; the discoverability format invariants established here also apply to any skill content deployed by `march update`. |
