---
applyTo: "**"
excludeAgent: "coding-agent"
---
<!-- Smithy-general layer: true in any repository that uses Smithy. Keep repository-specific rules out of this file. -->

# Reviewing a pull request produced by the Smithy pipeline

Most pull requests here come from one Smithy command and deliver one unit of
a written plan. Review the change against that plan, not against what you
would have built.

## Find the plan first

- The title or description names the command (`render`, `mark`, `cut`,
  `forge`, `strike`, `fix`) and the artifact the work came from.
- A `forge` pull request implements **one slice** of one `.tasks.md` file.
  Open that file and read the slice, its acceptance criteria,
  `## Specification Debt`, `## Open Implementation Questions`, and
  `## Dependency Order` before you comment.
- Authority runs downward: RFC → feature map → spec → tasks → code. When the
  code matches the tasks file and you believe the tasks file is wrong, say the
  *plan* is wrong and name the artifact. Do not ask the code to contradict it.

## Slice scope

- Do not request work the tasks file assigns to a later slice or story, or
  that an open `SD-NNN` or `IQ-NNN` row already records. Intermediate states
  between slices are expected.
- One exception, worth one comment: if merging this slice **alone** leaves the
  default branch broken, or two shipped pieces incompatible until a later
  slice lands, say so as a merge-ordering risk and name the slice that
  resolves it.
- A tasks file whose boxes are all checked is a historical record. Do not ask
  for it to be rewritten to match later changes.

## Say what kind of finding it is

Begin a comment with **Steering question:** when it asks for a choice only a
person can make: scope, whether a requirement should exist, which of two
designs to take. Leave it as a question; do not propose a fix as though the
answer were known. Anything else — a defect, a contradiction with a source the
change cites, a stale path — is an ordinary finding with a concrete fix.

## Before you post

- Check formatting claims against the file, never the diff. Diff prefixes and
  table pipes are not file content: do not report doubled leading pipes,
  changed list indentation, or `\|` inside a table cell (that escape is
  required there) unless the raw file shows it.
- Read the pull request's current head and description. A file that "does not
  exist" may have landed after the commit you looked at.
- Do not ask for speculative hardening or performance work without naming the
  requirement it violates. The spec's success criteria state the budgets.
- One comment per root cause. Do not repeat a finding on each file that
  mirrors the same source.
