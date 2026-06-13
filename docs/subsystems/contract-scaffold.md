# Subsystem Contract Scaffold

Subsystem contracts live at `docs/subsystems/<name>/contract.md`, where
`<name>` is the stable subsystem or role slug.

Every subsystem contract must include these required H2 sections:

| Required heading | Purpose |
|------------------|---------|
| `## Public Interface` | Externally consumed routes, commands, types, roles, or protocol surfaces, depending on the subsystem shape. |
| `## Invariants` | Behavioral promises the subsystem maintains. |
| `## Error Modes` | Externally visible failure conditions and outcomes. |

Authors may add other sections when useful, such as an overview, glossary, or
integration notes. The three required H2 sections above must appear in every
subsystem contract so later presence checks can key on the same heading names
for all contracts.

## Minimum Template

```markdown
# Contract: <Subsystem or Role>

## Public Interface

<!-- Externally consumed routes, commands, types, roles, or protocol surfaces,
     depending on the subsystem shape. List what other subsystems depend on. -->

## Invariants

<!-- Behavioral promises this subsystem maintains — what callers can always
     rely on holding true. -->

## Error Modes

<!-- Externally visible failure conditions and their outcomes — what callers
     observe when something goes wrong. -->
```

Copy the template into `docs/subsystems/<name>/contract.md` and fill it with
the contract for that specific subsystem or role in the later authoring work.
