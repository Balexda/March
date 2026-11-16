---
applyTo: ".claude/commands/**,.claude/prompts/**,.claude/agents/**,.claude/hooks/**,.claude/skills/smithy*/**,.agents/skills/**,.codex/agents/**,tools/codex/**,.smithy/smithy-manifest.json"
excludeAgent: "coding-agent"
---
# Reviewing the committed Smithy snapshot

These files are the output of `smithy update`, tracked in
`.smithy/smithy-manifest.json`. They come from the Smithy package, not from
this repository, and are refreshed by the `Smithy upgrade` workflow.

- Do not review the rendered text for content. A finding about a Smithy
  command's wording or behaviour belongs upstream in Smithy, not here.
- Do not ask for these files to be regenerated or report them as stale.
- Hand edits are what to catch: a change here outside an upgrade pull
  request, or with no `smithy update` run named in the description.

`.claude/settings.json` and the generated `.claude/skills/march.*` skills
are not part of this snapshot; the `march.*` skills are generated from
`src/templates/skills/`.
