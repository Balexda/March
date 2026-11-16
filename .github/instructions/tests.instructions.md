---
applyTo: "**/*.test.ts,**/*.test.mjs,tests/**,scripts/run-layered-tests.mjs,scripts/test-taxonomy.mjs"
excludeAgent: "coding-agent"
---
# Reviewing March tests

The strategy is in `docs/testing-strategy.md`; the day-to-day rules are in
`CONTRIBUTING.md` under Testing.

## Check

- **Every test file opens with a tag block** in the JSDoc `/** … */` form,
  before imports: exactly one scope (`@l0`–`@l3`), one determinism
  (`@deterministic`, `@stochastic`), and one channel (`@ci`, `@scheduled`).
  The layer runner reads only that leading block; a `//` comment or a tag
  after the imports drops the file from every layer.
- **The scope is the narrowest true one.** L0 touches no git, docker, or
  network. An L1 test whose assertion depends on docker is L2. An L2 test
  that needs the Legate loop is L3.
- **The PR gate costs nothing.** A `@ci` test never calls a live backend. A
  backend exchange in CI is a checked-in cassette; refreshing one is its own
  reviewed change.
- **Governed legacy files.** `src/spawn/container-launch.test.ts` and
  `src/spawn/snapshot-build.test.ts` follow the migration policy in
  `CONTRIBUTING.md#test-layer-migration`. A material edit (assertions, mocked
  process behaviour, fixtures, the boundary driven) needs a Cucumber.js port
  in the same pull request; formatting, comments, import order, tag-block
  edits, and mechanical renames do not.
- **Quarantine stays visible.** A quarantined test lives under
  `tests/quarantine/`, its index (`tests/quarantine/INDEX.md`) is
  regenerated with `march quarantine index`, and the staged layers exclude
  it. A test silenced with `.skip` instead is a finding.
- **A behaviour change comes with a test change.** If it does not, ask
  which test covers it.

## Do not ask for

- A Cucumber.js port of a governed file for a non-material edit, or of any
  file outside the governed pair.
- `@stochastic` or `@scheduled` coverage the spec did not ask for.
- Exact-string assertions on live model output.
