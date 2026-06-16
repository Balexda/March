# Feature Map: Subsystem Contract Documentation Track

**Source RFC**: `docs/rfcs/2026-002-layered-testing-framework/layered-testing-framework.rfc.md`
**Milestone**: M2 — Subsystem Contract Documentation Track
**Created**: 2026-05-21

## Features

The seven M2 contract documents are produced across three authoring features:
**F2** yields four (hatchery, brood, herald, castra), **F3** yields two (spawn,
legate), and **F4** yields one (steward) — seven contracts in total.

### Feature 1: Contract Scaffold & Required-Section Schema

**Description**: Establishes the shared spine every other feature keys on — the
`docs/subsystems/<name>/contract.md` directory layout, the three mandatory
section headings (`## Public Interface`, `## Invariants`, `## Error Modes`), the
`<!-- BEGIN AUTOGEN -->` / `<!-- END AUTOGEN -->` marker convention, the
`docs/subsystems/contract-freshness.config.json` schema shape, and the recorded
Steward source-binding decision. Lands first and small; carries no contract prose
of its own.

**User-Facing Value**: The Operator-as-Test-Author and downstream M3/M5 test
authors get one canonical, predictable contract shape to read and assert against,
instead of seven hand-rolled heading styles. Freezing the section vocabulary up
front prevents a late schema change from invalidating already-authored contracts.

**Scope Boundaries**:
- Includes: the directory convention; the three required headings as a template;
  the AUTOGEN delimiter convention and its placement rule; the
  `contract-freshness.config.json` schema (shape only, not the populated glob
  entries); an authoring rule that `## Invariants` and `## Error Modes` be written
  as *assertable* statements (so the contracts are test targets, not just prose);
  the documented decision that Steward's interface is a Castra-consumer surface.
- Excludes: authoring any subsystem's contract body (F2/F3/F4); the presence or
  freshness check logic (F5); the autogen extraction tool (F7); the populated
  source-glob entries (F5).

### Feature 2: Containerized-Service Contracts (Hatchery, Brood, Herald, Castra)

**Description**: Authors the four Fastify-service contract documents, each
documenting the subsystem's **HTTP route surface** (method, path, request/response
envelope) plus its invariants and error modes. Brood's `## Invariants` records the
teardown ordering (container → Castra steward removal → worktree by exact tracked
path) and the never-`git worktree prune` guarantee.

**User-Facing Value**: The wire contract is what actually breaks between
containerized services, so capturing the HTTP envelopes as explicit artifacts
gives L2 cross-subsystem tests a real boundary to assert against and gives the
CI Failure Triager a documented baseline for what each service promises.

**Scope Boundaries**:
- Includes: `docs/subsystems/{hatchery,brood,herald,castra}/contract.md` with all
  three required sections; HTTP route/envelope documentation; Brood's teardown +
  never-prune invariant transcribed from the established source; empty AUTOGEN
  markers placed where the TS client/types surface will be backfilled.
- Excludes: the Steward role's consumer surface even though it is hosted in Castra
  (F4 owns it); generating the AUTOGEN block contents (F7); the freshness globs
  that watch these source paths (F5).

### Feature 3: TypeScript-Surface Contracts (Spawn, Legate)

**Description**: Authors the two non-HTTP subsystem contracts whose
`## Public Interface` documents the exported TypeScript surface (entrypoint
types and functions), plus invariants and error modes. Neither Spawn (one-shot
execution context) nor Legate (the loop) runs a Fastify service, so these
contracts carry no HTTP route section.

**User-Facing Value**: Spawn and Legate are load-bearing boundaries the harness
depends on at runtime; documenting their typed surface as explicit, assertable
contracts closes the same drift gap the service contracts do, at the TS-surface
scope.

**Scope Boundaries**:
- Includes: `docs/subsystems/{spawn,legate}/contract.md` with all three required
  sections; exported-signature-level public-interface prose; empty AUTOGEN markers
  for F7 to backfill.
- Excludes: HTTP route documentation (these subsystems have none); the Steward
  contract (F4); generating the AUTOGEN block contents (F7).

### Feature 4: Steward Contract (Castra-Consumer Surface)

**Description**: Authors `docs/subsystems/steward/contract.md` for the Steward
role, which has no `src/steward/` module — it is a role hosted in Castra and
driven over Castra's bearer-token HTTP API. Its `## Public Interface` documents the
**Castra session-launch consumer surface** (`src/castra/client.ts` —
launch/send/output/remove — as consumed by `src/hatchery/spawn-handoff.ts`) plus
the steward-session role/lifecycle invariants, cross-referencing Castra's contract
for the server-side wire shapes rather than re-documenting them.

**User-Facing Value**: The Spawn → Steward handoff is the RFC's marquee L2/M3
scenario; a Steward contract that pins the consumer surface gives that test an
explicit target, and resolving where Steward "lives" prevents the freshness check
from having a silent coverage hole exactly at the highest-value boundary.

**Scope Boundaries**:
- Includes: the Steward contract with all three required sections; role/lifecycle
  invariants and error modes written as assertable statements; the non-overlapping
  freshness-glob partition vs. Castra (Steward watches `src/castra/client.ts` +
  `src/hatchery/spawn-handoff.ts`; Castra watches `src/castra/server.ts`, which
  defines the `/v1/sessions*` route surface inline); cross-references to Castra's
  wire contract.
- Excludes: re-documenting Castra's `/v1/sessions*` server route envelopes (F2
  owns the Castra wire surface); changing any Steward/Castra source code.

### Feature 5: Contract Presence & Freshness Check

**Description**: Delivers the single local verdict authority — one
`npm run docs:contracts:check` command that runs both halves of the verdict: the
**presence check** (every contract carries all three required sections) and the
**freshness check** (a PR touching a subsystem's public-source paths without
touching its `contract.md` fails). It reads the populated source-glob → contract
mapping in `docs/subsystems/contract-freshness.config.json` and reproduces the CI
verdict locally.

**User-Facing Value**: The Operator can run one command and get the exact verdict
CI will render, so contract drift and missing sections surface before review
rather than as a red check requiring log archaeology — and the single-command
design removes the presence-vs-freshness naming ambiguity.

**Scope Boundaries**:
- Includes: the `docs:contracts:check` script; presence verification against the
  F1 schema; freshness verification against the diff; the **populated**
  `contract-freshness.config.json` glob entries (using F1's schema and F4's Steward
  partition); the shared verdict logic that F6 leaves available as an opt-in check.
- Excludes: the edit-time maintenance convention that keeps contracts current (F6);
  the AUTOGEN extraction tool (F7); the contract content itself (F2/F3/F4); resolving
  the precise public-source-path definition (carried as debt SD-010).

### Feature 6: Contract-Freshness Maintenance Convention

**Description**: Establishes the **convention** by which subsystem contract docs stay
current — *not* an enforcement vehicle that fails PRs. Per the operator's SD-002
resolution (PR #294), this milestone enforces nothing automatically: contract docs are
maintained at edit time (the Smithy agents used for most edits already update affected
docs as part of their change), and the mechanically-derivable regions are refreshed by
F7's **deterministic** `docs:contracts:extract` extractor (e.g. from Fastify controller
endpoints and exported TS signatures). No AI/LLM step runs on every check-in. F5's
verdict stays available as an opt-in, advisory local check. Integrates last.

**User-Facing Value**: Keeps the contracts honest over time without spending tokens on
an AI bot per check-in or standing up CI — drift is avoided by maintaining the doc in
the same change that alters the surface, in keeping with March's "Smithy decomposes;
March executes" posture, while staying cheaply reversible to a directive or CI workflow
if drift later slips through.

**Scope Boundaries**:
- Includes: the edit-time maintenance convention; references to F7's deterministic
  auto-gen and F5's opt-in advisory check; the convention's documentation in
  `CONTRIBUTING.md`, `CLAUDE.md`, and `AGENTS.md`; the operator-decision record that
  SD-002 resolved toward **no enforcement gate** for this milestone.
- Excludes: a Smithy-agent enforcement directive that fails PRs, and a
  `.github/workflows/contract-freshness.yml` GitHub Actions workflow (both rejected-but-
  cheaply-reversible SD-002 alternatives); the verdict logic itself (F5); the
  deterministic extractor itself (F7); the structural AST-diff escalation path (RFC
  SD-002 defers it until drift is observed). SD-011 (enforcement strength) is closed as
  moot — with no gate, the question does not arise.

### Feature 7: TypeScript Public-Interface Autogen Tool

**Description**: Delivers the committed, non-interactive extraction tool runnable
via `npm run docs:contracts:extract` that backfills the `<!-- BEGIN AUTOGEN -->` /
`<!-- END AUTOGEN -->` block inside each TS-typed subsystem's `## Public Interface`.
Narrow by design — exported signatures only, deterministically ordered — so the
generated block does not churn on cosmetic source moves and trip the freshness
check.

**User-Facing Value**: Keeps the human-authored interface prose reconciled with the
real exported types automatically, so the most drift-prone part of each contract
stays accurate without hand-maintenance.

**Scope Boundaries**:
- Includes: the `docs:contracts:extract` tool; narrow exported-signature
  extraction with deterministic ordering; population of the AUTOGEN regions placed
  by F2/F3 (and any typed client/types surface in F2's service contracts).
- Excludes: authoring the surrounding prose (F2/F3 own it); rendering, cross-linking,
  or per-type narrative; generating the HTTP route documentation (hand-authored in
  F2); the presence/freshness check (F5).

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-010 | What counts as a subsystem's "public source paths" for the freshness globs in `contract-freshness.config.json`? Unresolved choice between (a) whole-directory globs (`src/legate/**`), (b) curated public-surface file lists (e.g. only `src/castra/client.ts`+`server.ts`, excluding `config.ts`/`types.ts`/`metrics.ts`), or (c) export-set membership rather than path membership. The choice changes which PRs the freshness check fires on and how much false-positive noise authors absorb — `src/legate/` alone spans 40+ files across `loop/`, `pure/`, `handlers/`, `clients/`, `state/`, and `init.ts`, and most are not public surface. | clarify:Constraints (RFC carry-forward) | High | Low | open | — |
| SD-011 | Where does the Smithy-agent directive (F6, per SD-002) enforce its verdict — at PR-review time (the directive reads the diff and flags drift in review) or as a blocking pre-merge gate? The two paths produce different feature surfaces: a review-time directive is advisory and lives in agent instructions, whereas a blocking gate needs a non-zero exit wired into the merge path. SD-002 is resolved toward "directive not CI workflow" but does not settle review-advisory vs merge-blocking. | feedback:Risks (SD-002 sub-question) | Medium | High | resolved | Closed as moot. Operator resolved SD-002 toward **no enforcement gate** (PR #294); F6 is a maintenance convention, so enforcement strength no longer arises. |

## Dependency Order

Recommended specification sequence. After F1 lands, the authoring features
(F2, F3, F4) and the tooling features (F5, F7) are mutually independent and can be
specced and cut in parallel; F6 integrates last because it references F5's verdict
and F7's extractor.

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| F1 | Contract Scaffold & Required-Section Schema | — | specs/2026-05-21-005-contract-scaffold-required-section-schema/ |
| F2 | Containerized-Service Contracts (Hatchery, Brood, Herald, Castra) | F1 | specs/2026-05-22-006-containerized-service-contracts-hatchery-brood-herald-castra/ |
| F3 | TypeScript-Surface Contracts (Spawn, Legate) | F1 | specs/2026-06-03-007-spawn-and-legate-contracts/ |
| F4 | Steward Contract (Castra-Consumer Surface) | F1 | specs/2026-06-03-008-steward-role-contract/ |
| F5 | Contract Presence & Freshness Check | F1 | specs/2026-06-06-009-contract-presence-and-freshness-verdict/ |
| F7 | TypeScript Public-Interface Autogen Tool | F1 | specs/2026-06-07-010-typescript-public-interface-autogen-extraction/ |
| F6 | Contract-Freshness Maintenance Convention | F1, F5, F7 | specs/2026-06-07-011-contract-freshness-enforcement-directive/ |

## Cross-Milestone Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| Milestone M3: First L2 Vertical Slice — Spawn → Steward | depended upon by | M3 asserts its L2 cassette scenario against M2's Spawn (F3) and Steward (F4) contracts. M3's Dependency-Order entry lists `Depends On: M1, M2`. |
| Milestone M4: L1 Gap-Fill (Hatchery) | depended upon by | M4 drafts the Hatchery contract concurrently and its tests retro-link to it; per RFC Decisions this is a concurrent soft dependency, not a hard blocker (M4's hard dependency is M1 only). |

_M1 (Test Legibility & Staged CI) runs concurrently with M2 and is neither a
prerequisite nor a dependent — M2 keeps contracts current with its own edit-time
maintenance convention rather than the staged `ci.yml` jobs M1 builds._
