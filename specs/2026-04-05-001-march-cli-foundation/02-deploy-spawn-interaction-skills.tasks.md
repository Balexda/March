# Tasks: Deploy Spawn-Interaction Skills

**Source**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.spec.md` — User Story 2
**Data Model**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.data-model.md`
**Contracts**: `specs/2026-04-05-001-march-cli-foundation/march-cli-foundation.contracts.md`
**Story Number**: 02

---

## Slice 1: Author Skill Content and Verify Discoverability

**Goal**: Replace the three bare placeholder content strings in `getM1Skills()` with substantive markdown that gives the operator's AI agent meaningful context about spawn concepts, and update the test suite to enforce content quality and Claude Code discoverability format invariants.

**Justification**: US1 established the deployment mechanism and file slots; US2 makes those files useful. When an operator opens a Claude Code session after `march init`, the deployed skill files should explain what spawn dispatch, spawn status, and output handling mean — not just announce that content is coming later. This slice closes that gap and locks in format invariants so content regressions are caught automatically.

**Addresses**: FR-002 (deploy skill files with content recorded in manifest); FR-012 (march. filename prefix); Acceptance Scenarios US2-1, US2-2, US2-3

### Tasks

- [ ] In `src/skills.ts`, update the JSDoc on the `content` field of `MarchSkill` (currently "The placeholder markdown content for this skill file") to "The markdown content for this skill file."
- [ ] In `src/skills.ts`, update the JSDoc on `getM1Skills()` to remove "placeholder" language; describe it as returning M1 skill files with spawn concept context for the Claude Code agent.
- [ ] In `src/skills.ts`, replace the `content` value for `march.spawn-dispatch.md` with substantive markdown: an `# March: Spawn Dispatch` H1, a purpose paragraph explaining what a spawn is (a containerized task dispatched to run independently on behalf of the operator), and a context paragraph describing when and why the AI agent should consider suggesting a spawn dispatch (long-running tasks, tasks requiring isolation, work that can proceed while the operator continues in-session). Content must be 2–4 paragraphs (~150–300 words), end with `\n`, and contain no CLI command examples that do not yet exist.
- [ ] In `src/skills.ts`, replace the `content` value for `march.spawn-status.md` with substantive markdown: an `# March: Spawn Status` H1, a purpose paragraph explaining the spawn lifecycle states (pending, running, completed, failed), and a context paragraph describing how the operator monitors spawn progress and what role the AI agent plays in relaying status. Same length and format constraints.
- [ ] In `src/skills.ts`, replace the `content` value for `march.output-handling.md` with substantive markdown: an `# March: Output Handling` H1, a purpose paragraph explaining what spawn output is (the artifacts and results produced by a completed spawn), and a context paragraph describing how output is surfaced to the operator and the AI agent's role in presenting and interpreting it. Same length and format constraints.
- [ ] In `src/skills.test.ts`, remove the three test cases (currently lines 74–93) that assert `skill.content` contains `"placeholder"` (one each for spawn-dispatch, spawn-status, and output-handling). These tests were correct for the placeholder era; they are now replaced by the invariant tests below.
- [ ] In `src/skills.test.ts`, add a `describe` block "skill content format invariants" that iterates all skills returned by `getM1Skills()` and asserts for each skill: (a) content starts with `"# March:"`, (b) `content.length > 200`, (c) content does not contain the string `"placeholder"`, (d) content ends with `"\n"`, (e) content does not contain null bytes (`"\0"`), (f) filename matches `/^march\.[a-z0-9-]+\.md$/`.
- [ ] In `src/skills.test.ts`, add per-skill semantic assertions confirming each skill's content is thematically on-topic: spawn-dispatch content contains `"spawn"` or `"dispatch"`; spawn-status content contains `"spawn"` or `"status"`; output-handling content contains `"output"`.
- [ ] Run `npm test` and verify all tests pass, including the pre-existing suites in `init.test.ts`, `cli.test.ts`, `manifest.test.ts`, and `deps.test.ts`.

**PR Outcome**: `march init` deploys three skill files that give a Claude Code session meaningful context about spawn concepts from the first open. Format-invariant and semantic tests prevent content regressions. No changes to deployment logic, manifest schema, CLI dispatch, or build config.

---

## Dependency Order

Recommended implementation sequence:

1. **Slice 1** — self-contained. Update `skills.ts` first (content and JSDoc), then update `skills.test.ts` (remove stale placeholder assertions, add format-invariant and semantic assertions), then run the full test suite.

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Initialize March Environment | depends on | US1 Slice 3 established the deployment mechanism, the `MarchSkill` interface with its `content` field, and the placeholder content this story replaces. `init.ts` is not modified here. |
| User Story 3: Update March Installation | depended upon by | US3's `march update` redeploys skill files; the content authored here is what gets redeployed on upgrade. The format invariants from this story's tests also serve as a reference for what valid skill content looks like. |
