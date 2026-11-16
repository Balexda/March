---
applyTo: "docs/subsystems/**"
excludeAgent: "coding-agent"
---
# Reviewing subsystem contract docs

Each `docs/subsystems/<name>/contract.md` describes one subsystem's public
surface. The shape is set by `docs/subsystems/contract-scaffold.md`.

## Check

- **Required sections.** `## Public Interface`, `## Invariants`, and
  `## Error Modes` are present. At most one `<!-- BEGIN AUTOGEN -->` /
  `<!-- END AUTOGEN -->` pair sits inside `## Public Interface`; only the
  extractor writes between the markers.
- **The contract matches the code.** Read each changed route, field, status
  code, and invariant against the source and the payloads actually sent.
  When they disagree, the code is the authority: say which line of the
  contract is wrong. This was the most useful kind of finding on these
  files.
- **Labels are current.** A surface marked "planned" that has shipped, or a
  route listed that no longer exists, is a finding.
- **Mappings agree.** A new contract or source path is registered in
  `subsystems.json` and `contract-freshness.config.json`.

## Weigh before posting

- **A documentation slice does not change runtime.** On a pull request that
  only documents, propose a wording fix, not new validation, a widened CI
  trigger, or a behaviour change. A real behaviour gap is a separate issue.
- Contracts are kept current at edit time. Do not ask for a CI or AI
  freshness gate.
