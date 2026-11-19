# Tasks: Stewards Open Pull Requests as the Bot

**Source**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.spec.md` — User Story 5
**Data Model**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.data-model.md`
**Contracts**: `specs/2026-11-15-013-tessera-credential-entitlement-service/tessera-credential-entitlement-service.contracts.md`
**Story Number**: 05

## Slice 1: Deliver Fail-Closed GitHub Credential Shims
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: An explicitly configured steward worktree can use Tessera for GitHub CLI and Git credentials.

**Justification**: The shims can be used and tested with the US4 CLI and a fake Tessera before Castra activates them for steward launches.

**Addresses**: US5 portion of FR-024, FR-025–FR-027, FR-042; AS 5.1–5.4 and AS 5.6 at the shim boundary.

### Tasks

- [ ] **Wrap the GitHub CLI with Tessera app credentials**

  Package a steward executable named `gh` using the US4 token command and the Steward Credential Shims contract.

  _Acceptance criteria_

  - Resolve the worktree's GitHub repository and request its app/write token from Tessera on every invocation, including repeated calls. Keep issued tokens in memory, out of arguments, files and diagnostics.
  - Run the real executable with unchanged arguments and preserve output and exit status. Replace inherited GitHub token variables and isolate its configuration from the host login.
  - Missing repository context, missing real executable, recursion and issuance failures exit nonzero with a sanitized one-line diagnostic before running the real executable. Cover AS 5.1, 5.3, 5.4 and 5.6 with fake Tessera and a substitute executable.

- [ ] **Expose the Tessera Git credential helper**

  Add the documented helper command with thin CLI dispatch and issuance in `src/tessera/`. Update the affected Tessera subsystem contract.

  _Acceptance criteria_

  - A Git HTTPS credential request for `github.com` identifies the actual target repository and returns the documented username and app/write token. Ambiguous GitHub requests fail closed.
  - Requests for other hosts return no credentials. Store and erase operations consume the protocol input without persisting a token.
  - Denial or outage aborts Git credential acquisition with a sanitized one-line reason, including when Git could otherwise prompt or consult another helper. Verify behavior through real Git credential plumbing with fake Tessera for AS 5.2–5.4.

## Slice 2: Activate Bot Authentication in Steward Sessions
<!-- audience: builder; mode: how-to; length: 5-15 steps; diagram: optional; examples: forbidden -->

**Goal**: Ordinary Castra steward launches use the Slice 1 shims with plain `gh` and `git push`.

**Justification**: Enable both credential paths and scrub their launch environment in one rollout so the default steward path has no gap where it can use ambient GitHub auth.

**Addresses**: FR-025–FR-028, FR-042; AS 5.1–5.6 through the steward launch path.

### Tasks

- [ ] **Provision credential shims for steward launches**

  Extend the host-side steward launch path in `src/castra/adapter.ts` and reuse Castra's steward asset provisioning where appropriate. Consume the steward Tessera configuration through the boundary established by SD-003 and apply the commit identity decision from SD-004.

  _Acceptance criteria_

  - New and relaunched steward sessions resolve the wrapper first on `PATH`. GitHub SSH remotes resolve to HTTPS, preserving the destination repository, and existing GitHub HTTPS remotes use the same helper. The configuration leaves the operator's global Git configuration and non-steward sessions untouched.
  - Git supplies repository context to the helper. Host helper chains, embedded credentials, inherited auth headers and prompts cannot take over for GitHub in the steward path. With a populated host login and inherited tokens, cover AS 5.1–5.4 and AS 5.6 using the normal launch path and fake endpoints.
  - Keep affected Castra and steward subsystem contracts current.

- [ ] **Scrub ambient GitHub tokens from steward tmux**

  Extend the anchor setup in `src/stack/up.ts` so `march up` cleans both GitHub token variables on the host tmux server Castra uses.

  _Acceptance criteria_

  - Neither token reaches new steward panes via a newly created anchor, an existing session environment or the running server's global environment. Later tmux environment imports cannot reintroduce the variables.
  - Verify AS 5.5 for cold startup and an already-running server. Verify that shell startup re-exports still cannot affect either shim. Surface scrub failures in startup diagnostics and an errored span without token values.

## Implementation Boundaries

Follow March's [vision](../../docs/vision.md) and [operating philosophy](../../docs/operating-philosophy.md) for unattended launches, scoped access and bounded failures. Use fake Tessera and GitHub in CI. Run the repository's typecheck, build, tests and CLI spot-checks where the CLI changes.

## Specification Debt
<!-- audience: reviewer; mode: reference; length: index table + 1-3 sentences per item; diagram: optional; examples: discouraged -->

| ID | Title | Source Category | Impact | Confidence | Origin |
|----|-------|-----------------|--------|------------|--------|
| SD-001 | Provider secret storage | Non-Functional Quality | High | Medium | spec:SD-001 |
| SD-002 | Service client-key storage | Domain & Data Model | High | Medium | spec:SD-002 |
| SD-003 | Steward client-key delivery | Interaction & UX | Medium | Low | spec:SD-003 |
| SD-004 | Steward commit identity | Domain & Data Model | High | Low | spec:SD-004 |
| SD-005 | Workflow write permission | Integration | Medium | Medium | spec:SD-005 |

SD-003 and SD-004 apply to S2. SD-005 governs the provider permission profile. The shims surface GitHub's permission errors without requesting broader access.

## Open Implementation Questions
<!-- audience: builder; mode: reference; length: one table row per question; diagram: optional; examples: discouraged -->

| ID | Question | Slice | Settled By | Origin |
|----|----------|-------|------------|--------|
| IQ-001 | Which launch hook preserves steward Git configuration across both new and reused worktrees? | S2 | reading code | local |

## Dependency Order
<!-- audience: builder+ai-input; mode: reference; length: tables only; diagram: optional; examples: discouraged -->

| ID | Title | Depends On | Artifact |
|----|-------|------------|----------|
| S1 | Deliver Fail-Closed GitHub Credential Shims | — | — |
| S2 | Activate Bot Authentication in Steward Sessions | S1 | — |

### Cross-Story Dependencies

| Dependency | Direction | Notes |
|------------|-----------|-------|
| US4 — Fetch Tokens Through One Client | depends on | Supplies the fail-closed token CLI and shared client. |
| US9 — Remove Ambient GitHub Credentials | depended upon by | Requires steward authentication to work before stack-wide removal of ambient credentials. |
