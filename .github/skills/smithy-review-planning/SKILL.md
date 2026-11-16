---
name: smithy-review-planning
description: "Review procedure for pull requests that add or change Smithy planning artifacts (.rfc.md, .features.md, .spec.md, .data-model.md, .contracts.md, .tasks.md, .strike.md): parent checks, the per-artifact checklist, and what each command's change should contain. Use during code review before commenting on one of these files."
---
<!-- Smithy-general layer: true in any repository that uses Smithy. Keep repository-specific rules out of this file. -->

# Reviewing Smithy planning artifacts

A planning pull request is reviewed against two things: the checklist for its
artifact type, and its parent artifact. Review whether the plan is right and
complete, not whether the prose is polished. Work through the steps in order.

## 1. Open the parent

| Changed file | Parent to open |
|--------------|----------------|
| `.rfc.md` | a `.prd.md`, when the header names one |
| `.features.md` | the RFC named in its header |
| `.spec.md`, `.data-model.md`, `.contracts.md` | the feature map and RFC named in its header |
| `.tasks.md` | the spec named on its `**Source**:` line |
| `.strike.md` | none; it is one self-contained slice |

## 2. Load the checklist for that artifact type

The checklists are maintained in one place: Smithy's audit command, which
`smithy init` deploys into the repository. Open whichever of these exists and
find the table headed `Audit Checklist (<suffix>)`:

- `.claude/commands/smithy.audit.md`
- `.agents/skills/smithy-audit/SKILL.md`
- `.gemini/skills/smithy-audit/SKILL.md`

Apply every row of that table to the changed artifact. When the repository's
own instructions name a newer source for the same checklists, prefer it. The
spec checklist describes the backend table; a UI spec's typed ledger
satisfies the same row.

## 3. Check the artifact against its parent

- **The link exists.** The parent's row for this child has its `Artifact`
  cell set to this file or folder, in the same pull request.
- **Nothing is widened.** No requirement, story, or slice appears without a
  parent row behind it. Narrowing is fine when the parent's out-of-scope
  section or debt table records it.
- **References resolve.** A tasks file cites acceptance scenarios and
  `FR-NNN` requirements that exist in the spec. `Depends On` cells in the
  child do not contradict the ordering the parent declares.
- **Open debt is handled, not decided.** Each open row in the parent is
  carried down with an `Origin` naming the parent row, resolved with a
  recorded answer, or left untouched. A child that quietly assumes one answer
  is the most valuable thing you can catch.

## 4. Check the change against the command that made it

| Command | The pull request should change | Look hardest at |
|---------|--------------------------------|-----------------|
| `ignite` | One new `.rfc.md` | Goals that name milestones. Exclusions phrased as "deferred to a later milestone". Unresolved questions left in prose instead of the debt table. |
| `render` | One new `.features.md`, and the milestone's `Artifact` cell in the RFC | Features small enough to be user stories. Missing or invalid feature-kind metadata. Dependencies stated in prose but absent from the table. |
| `mark` | A new spec folder, and the feature's `Artifact` cell in the feature map. For a UI feature, also its `.design.md` and `.flow.md` files and one stub test body per flow | Stories at the wrong altitude. A story with nothing in the contracts or data model to support it. Requirements that mandate behaviour an agent already performs. Priority order. |
| `cut` | One new `.tasks.md`, and the story's `Artifact` cell in the spec | Tasks that assume an answer to open debt. A dependency the tasks file declares on another story that the spec's table does not show. Slices that are not one pull request each. Standalone test, research, or verification tasks. |

Corrections written back to the parent artifact are normal. Flag a planning
pull request that changes source code, configuration, or tests beyond those
stubs.

## 5. Weigh what you found

- **A choice only a person can make.** Phrase it so it can be answered in one
  sitting without opening an editor, and name the alternatives. The full test
  is under "The steering test" in the deployed `smithy-plan-review` agent.
- **An unknown that building, testing, or reading the code will settle** is
  not debt. In a tasks file it belongs under
  `## Open Implementation Questions`.
- **A wording preference** is not a finding where the meaning is unambiguous
  to the next command.
