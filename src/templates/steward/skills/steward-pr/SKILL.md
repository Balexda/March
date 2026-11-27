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

## Validation

State which checks ran and their outcomes. End with a plain-text receipt on
its own line in the format `REVIEW <receipt ID> <status>`, using the ID from
the current handoff. Choose one status.

- `passed` when the commit is approved and verification succeeded.
- `unavailable` when the commit is approved and verification could not run.
- `failed` when the commit needs corrections, including a failed check.
