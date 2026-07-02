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

## Contract Freshness Configuration Shape

Future contract freshness checks read their source-to-contract mapping from
`docs/subsystems/contract-freshness.config.json`. The artifact is versioned so
checker behavior can evolve explicitly, and each entry maps one contract
artifact to the public source selectors that make that contract stale when
changed.

| Field | Required | Purpose |
|-------|----------|---------|
| `version` | Yes | Stable integer schema version consumed by later checker behavior. |
| `contracts` | Yes | Array of contract freshness ownership entries. |
| `contracts[].name` | Yes | Stable subsystem or role slug for the owner. |
| `contracts[].contractPath` | Yes | Repo-relative path to the owning `docs/subsystems/<name>/contract.md` artifact. |
| `contracts[].publicSourcePaths` | Yes | Repo-relative public-source path selectors associated with that contract. |
| `contracts[].notes` | No | Optional ownership context for boundaries that need clarification. |

Freshness ownership entries should describe non-overlapping public source
surfaces: a later local verdict command must be able to determine which single
contract belongs to a changed public source path. If later work needs overlapping
selectors, that work must define the conflict rule before relying on the
overlap. This scaffold records only the schema and ownership rules; populated
selectors for Hatchery, Brood, Herald, Castra, Spawn, Legate, Steward, or any
other subsystem belong to later freshness-checker work.

Steward is represented as a role-level contract bound to a Castra-consumer
surface rather than as a standalone source module. Its freshness entry may use
`notes` to record that ownership decision while `contractPath` still points at
the Steward role contract and `publicSourcePaths` remains the selector field a
later checker consumes.

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
