# Subsystem Contract Scaffold

Subsystem contracts live at `docs/subsystems/<name>/contract.md`, where
`<name>` is the stable subsystem or role slug.

Every subsystem contract must include these required H2 sections:

| Required heading | Purpose |
|------------------|---------|
| `## Public Interface` | Externally consumed routes, commands, types, roles, or protocol surfaces, depending on the subsystem shape. |
| `## Invariants` | Observable behavioral promises the subsystem maintains and later tests can check. |
| `## Error Modes` | Failure conditions and externally visible outcomes that later tests can assert. |

Authors may add other sections when useful, such as an overview, glossary, or
integration notes. The three required H2 sections above must appear in every
subsystem contract so later presence checks can key on the same heading names
for all contracts.

When a contract reserves generated exported-signature content, place one
AUTOGEN marker pair inside `## Public Interface`:

```markdown
<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->
```

Generated public-interface content belongs between those markers. The bounded
AUTOGEN block is the only region intended for automated replacement by later
tooling; human-authored public-interface prose may appear before or after the
marker pair and remains outside the replacement boundary. An empty marker pair
is a valid placeholder when no generated content exists yet.

Mechanically-derivable public-interface regions are refreshed by Feature 7's
deterministic `npm run docs:contracts:extract` tool when that extractor is
available. This scaffold records the convention-level handoff only: Feature 7
owns extraction, replacement, check-mode, and write-mode behavior. Until that
tool is present, authors and Smithy agents keep generated-region content current
manually as normal edit-time upkeep. Neither path creates a CI job, a
per-check-in AI/LLM validation step, or a PR/slice/merge gate; Feature 5's
`npm run docs:contracts:check`, when used, remains opt-in and advisory.

Generated-region output is expected to be deterministic and ordered. Cosmetic
source moves alone should not churn the generated block when the public surface
is unchanged.

## Minimum Template

```markdown
# Contract: <Subsystem or Role>

## Public Interface

<!-- Externally consumed routes, commands, types, roles, or protocol surfaces,
     depending on the subsystem shape. List what other subsystems depend on. -->

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

## Invariants

<!-- Observable behavioral promises this subsystem maintains — what callers,
     operators, or peer subsystems can see and later L2 or L3 scenarios can
     check. Write each entry as a concrete assertion that fits the subsystem's
     public shape: HTTP route, CLI command, exported type, role handoff, or
     protocol surface. Avoid background-only prose that cannot produce a
     specific test assertion. -->

## Error Modes

<!-- Externally visible failure conditions and outcomes. For each entry, name
     the failure condition and the expected outcome that callers, operators, or
     tests can observe: a returned error, emitted event, terminal state,
     bounded diagnostic, clean exit, or the equivalent outcome for this
     subsystem's public shape. Keep failures assertable by later L2 or L3
     scenarios instead of recording them only as narrative context. -->
```

Copy the template into `docs/subsystems/<name>/contract.md` and fill it with
the contract for that specific subsystem or role in the later authoring work.
