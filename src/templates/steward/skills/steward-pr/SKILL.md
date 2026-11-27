---
name: steward-pr
description: "Review a completed Steward spawn after Hatchery verifies and pushes its integration commit. Return a review receipt for the Steward publication flow."
allowed-tools: Bash(git status *) Bash(git log *) Bash(git diff *) Bash(git branch *) Bash(git show *)
---
# steward-pr

Review the published commit from the handoff on its exact branch. Check the
diff against the operator request and the slice's acceptance criteria, including
completion checkboxes. Run the smallest meaningful verification available for
the changed code. Leave the commit and branch intact.

## Summary

Describe the outcome of your review. If the commit needs corrections,
include a `NEED: <problem> — <next action>` line. Keep the reason brief
and omit credentials and raw output.

Hatchery uses the Steward credential boundary to look up or create the PR.
It builds the PR Summary from the validated spawn, extraction and pushed
branch. Leave GitHub publication to that flow.

## Steering check (planning steps)

For a planning step (`smithy.cut`, `smithy.render`, `smithy.mark`,
`smithy.strike`, `smithy.ignite`), check whether the change gates any slice on
an unresolved decision before you report. That is wording such as "slice 1
must not be forged until SD-001 is resolved", "blocked until X is decided", or
a slice that cannot be built until a human chooses between options.

Ordinary specification debt is not a reason to escalate. Agents build
through open debt. Only an explicit gate on a decision the work cannot proceed
without counts.

If there is such a gate, do not report the change as done:

- For each steering question, print one line that begins with `STEERING:` and
  gives the question, its options with their trade-offs, and the slices it
  blocks.
- Use the `steering` receipt status (below), and end with a `NEED:` line
  asking the human to decide.
- Hatchery opens the PR with the `march:needs-steering` label. March will not
  auto-merge the PR while that label is set.

When the human answers, apply the decision to the spec or task file (mark the
debt row resolved and remove the gate), commit and push to the PR branch,
remove the label with `gh pr edit <number> --remove-label march:needs-steering`,
and report the PR as done.

## Validation

State which checks ran and their outcomes. End with a plain-text receipt on
its own line in the format `REVIEW <receipt ID> <status>`, using the ID from
the current handoff. Choose one status.

- `passed` when the commit is approved and verification succeeded.
- `unavailable` when the commit is approved and verification could not run.
- `failed` when the commit needs corrections, including a failed check.
- `steering` when the commit is correct but gates a slice on an unresolved
  decision (see the steering check). Never use it for ordinary spec debt.
