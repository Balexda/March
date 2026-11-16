---
applyTo: "src/**/*.ts,scripts/**/*.mjs"
excludeAgent: "coding-agent"
---
# Reviewing March runtime source

March runs agent sessions unattended. Most valuable findings here were a
failure path that hangs or reports success, or one surface changing without
its counterparts. Before commenting on a service, dispatch, teardown, or
event change, load the `march-review-runtime` skill and follow it.

## Check

- **The three rules of thumb** (`docs/operating-philosophy.md`). No prompt or
  blocking wait inside an autonomous component; access widened only through a
  typed interface; failures exit cleanly. A command that swallows an error
  and exits 0, a `fetch` or docker call with no timeout, or a JSON stdout
  contract that breaks on failure is a finding.
- **Ownership.** Code sits under the subsystem `AGENTS.md` assigns it.
  `src/cli.ts` only imports `runCli`; `src/cli/` stays thin.
- **Teardown by exact tracked path.** Brood removes the worktree and branch it
  registered, never a blanket `git worktree prune`. A not-found response from
  a dependency is a failed teardown, not a success.
- **Herald is the sequencer.** A new event type is added to the union and
  reducer in `src/herald/events.ts` **and** the `POST /events` validator.
  `EventType` is a metric label, so keep it low-cardinality.
- **Every profile.** One legate drives all registered profiles. A call that
  reads per-profile state passes the profile; one profile's failure must not
  stall the others.
- **Observability moves with dispatch** (`docs/Observability.md`). New
  dispatch path or lifecycle action → a span; new failure mode → an errored
  span with the right failure stage. Service-side spans nest on the slice's
  deterministic trace id as children, never as a new root.
- **CLI reads services over HTTP.** `march sessions` and `march doctor` must
  work from a plain `npm i -g`: no runtime reads of source, compose files, or
  the repository (`docs/open-core-boundary.md`, rule 1).
- **Public surface → contract.** A change to a route, command, or exported
  type mapped in `docs/subsystems/contract-freshness.config.json` updates
  that subsystem's `contract.md` in the same pull request.

## Weigh before posting

- **Moved code keeps its old bugs.** In a behaviour-preserving extraction, or
  a change that keeps parity with an existing projection, flag only what the
  diff introduces. A pre-existing defect is worth a follow-up note, not a
  blocking change that breaks parity.
- **Verify an API claim before making it.** Several declined findings
  asserted Node, jq, or library behaviour that was wrong. Name the
  documentation or source you checked.
- **Read the current head.** Findings on code a later commit removed are
  noise.

## Do not ask for

- Skill or tool allowlists for steward or spawn sessions. They run with
  `--permission-mode auto` by design; that is the minimum bar, not a gap.
- A per-PR CI or AI gate for contract freshness. Contracts are kept current
  at edit time; `npm run docs:contracts:check` is advisory and local.
- Pruning a shared cache from one profile's call path. Castra is shared
  across profiles.
- Committing `dist/`.
