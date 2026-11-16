---
name: march-review-runtime
description: "Review procedure for pull requests that change March runtime code: the services (Hatchery, Brood, Herald, Legate, Castra, Statio), spawn, dispatch, teardown, the event log, and CLI commands over them. Use during code review before commenting on src/ changes beyond a one-line fix."
---
# Reviewing a March runtime change

March's value is that an operator can walk away. Review each change by
asking what happens when it fails while nobody is watching. Work through the
steps in order; stop at the first that applies to nothing in the diff.

## 1. Find the plan and the owner

- If the description names a slice, open the `.tasks.md` file and read that
  slice and its acceptance criteria. Work a later slice owns is out of scope
  (see the review-stance instructions).
- Map each changed file to its owning subsystem with the table in
  `AGENTS.md`. Behaviour placed in the wrong subsystem, or a CLI handler that
  grew domain logic, is worth one comment.

## 2. Walk every failure path

For each new call to another service, docker, git, `gh`, or the filesystem:

| Question | A finding when |
|----------|----------------|
| Does it time out? | A `fetch`, docker read, or child process can wait forever |
| Does failure surface? | An error is caught and the command exits 0, or a 404 counts as done |
| Is the output contract kept? | A JSON stdout command prints prose or nothing on failure |
| Is the terminal state recorded? | A failed spawn or teardown leaves no record or event for consumers |
| Is it safe input? | A request field is not whitelisted, a path is not absolute, a ref name is not validated |

The rules behind this are in `docs/operating-philosophy.md`; cite the rule
number.

## 3. Check what moves together

| When the diff… | Also expect |
|----------------|-------------|
| adds a Herald event type | union + reducer in `src/herald/events.ts`, the `POST /events` validator, the metric label set |
| adds a route or changes a payload | the client in the same subsystem, the subsystem's `contract.md` |
| adds a dispatch path or lifecycle action | a span, and an errored span on its failure path |
| adds a metric | its module under `src/observability/`, a cached instrument, a dashboard panel |
| touches trace-id derivation | the same change in all three id-helper copies |
| changes what an image needs at runtime | a `COPY` in that service's Dockerfile runtime stage |
| changes `src/templates/skills/` | the regenerated `.claude/skills/march.*` variant |
| changes behaviour | a test at the narrowest true layer, with its tag block |

## 4. Check the multi-profile and multi-process shape

- **Profiles.** The single legate iterates every registered profile. Per-
  profile reads pass the profile (for example `?profile=`); one profile's
  exception is caught inside its own iteration.
- **Sequencing.** Herald assigns every `seq`, including for legate posts, and
  forces the legate source on posted transitions. State is the fold of the
  log; there is no side file to keep in sync.
- **Teardown.** Brood removes exactly what it registered: container, steward,
  then worktree and branch by tracked path. A session's `kind` does not
  change after registration. Archive lookups go through the parent spawn.
- **Substrates.** Container and worktree calls go through
  `TeardownSubstrate`; registry calls through `SessionRepository`. A direct
  call that bypasses the adapter is a finding.
- **The CLI over HTTP.** Operator commands talk to services through their
  clients and environment URLs, never by reading source or compose files.

## 5. Weigh what you found

- **Introduced versus inherited.** On a move or a parity-preserving change,
  a defect that already existed is a follow-up note, not a blocker.
- **Verified versus assumed.** Before claiming how Node, Fastify, docker, jq,
  or `gh` behaves, check its documentation or source and say which.
- **Designed versus missed.** Auto permission mode for sessions, a reducer
  that overwrites a session id on re-dispatch, and no cache pruning in a
  single profile's path are deliberate. Read the surrounding comment and the
  spec before calling something a bug.
- **A choice only a person can make** begins with **Steering question:**.
