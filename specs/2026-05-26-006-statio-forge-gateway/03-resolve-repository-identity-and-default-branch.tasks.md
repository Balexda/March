# Tasks: Resolve Repository Identity and Default Branch

**Source**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.spec.md` — User Story 3
**Data Model**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.data-model.md`
**Contracts**: `specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md`
**Story Number**: 03

---

## Slice 1: Add Repo Metadata Resolution

**Goal**: Deliver Statio's repository identity read behind the forge gateway seam, returning the owner/name and default branch from one `gh repo view` operation.

**Justification**: This slice is a standalone working increment because it gives later Statio routes and PR reads one tested source for repository metadata without changing existing consumers or requiring the HTTP transport story.

**Addresses**: FR-001, FR-003, FR-005, FR-014, FR-016, FR-019; Acceptance Scenarios 3.1-3.3

### Tasks

- [ ] **Define Statio repo metadata types**

  Add the US3-facing Statio types and errors under `src/statio/`, following the Castra service boundary pattern without adding command logic to `src/cli.ts`. Keep the scope to `RepoInfo`, the forge read seam needed by `repoInfo()`, and the error shape required by the contracts and AS 3.3.

  _Acceptance criteria:_
  - `RepoInfo` matches the data model fields for owner and default branch
  - The forge read seam exposes `repoInfo()` as an async operation
  - Forge failures can be represented as `forge_error` without throwing uncaught dependency details
  - No existing `gh` call site or consumer behavior is changed

- [ ] **Implement `repoInfo()` through `gh repo view`**

  Add the Statio forge adapter logic under `src/statio/` to resolve repository metadata from the existing working repo context. It should shape one `gh repo view` result into `RepoInfo`, bound the command execution, and satisfy AS 3.1-3.3 without adding a second caller-side round trip for the default branch.

  _Acceptance criteria:_
  - A resolvable repository returns both owner and default branch from the same forge read
  - Failed, timed-out, unreachable, or unparseable `gh` results become a `forge_error` outcome
  - The adapter remains stateless and performs no `git` operations
  - Tests cover success, malformed output, and forge failure behavior for AS 3.1-3.3

**PR Outcome**: Statio has a tested in-process `repoInfo()` forge read that later HTTP/client slices can expose without re-deriving repository identity.

---

## Specification Debt

| ID | Description | Source Category | Impact | Confidence | Status | Resolution |
|----|-------------|-----------------|--------|------------|--------|------------|
| SD-001 | inherited from spec: Env-var naming convention: `MARCH_STATIO_*` (this spec) vs. Castra's `CASTRA_*`. Two conventions exist in the stack. | Constraints | Low | Medium | inherited | — |
| SD-002 | inherited from spec: Forge-auth provisioning: env token vs. read-only `~/.config/gh` mount, and interaction with `gh`'s own credential resolution. | Domain & Data Model | Medium | Medium | inherited | — |
| SD-003 | inherited from spec: Whether the resilience seam (rate-limit/retry/read-cache) ships in this foundation spec (default-off) or arrives with the first measured need. | Architecture | Low | Medium | inherited | — |
| SD-004 | inherited from spec: `reviewThreads` GraphQL response shaping (resolved-thread filtering + comment-id dedup) must match `sense-io.ts`'s current output exactly for a behavior-preserving Herald cutover. | Domain & Data Model | Medium | High | inherited | — |

---

## Dependency Order

Recommended implementation sequence:

| ID | Title | Depends On | Artifact |
|----|-------|-----------|----------|
| S1 | Add Repo Metadata Resolution | — | — |

### Cross-Story Dependencies

Direction must be either `depends on` or `depended upon by`.

| Dependency | Direction | Notes |
|------------|-----------|-------|
| User Story 1: Read a Pull Request's State Through the Gateway | depended upon by | PR reads use this story's owner resolution for repository scoping. |
| User Story 2: Discover and List Pull Requests | depended upon by | PR discovery uses this story's owner resolution for repository scoping. |
| User Story 4: Read Unresolved Review Threads | depended upon by | Review-thread GraphQL reads need the owner/name identity resolved here. |
