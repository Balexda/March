# Contracts: Interactive Session Attach Helper
<!-- applicability: code-shaped features only -->

## Interfaces
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Signature | Input | Success | Failure |
|-----------|-------|---------|---------|
| `march brood attach <name>` | One unprefixed exact name, for example `conductor`, from a terminal on the host with access to Castra's tmux server | Interactive terminal attached to Castra's resolved target. Normal detach exits zero and leaves the session running. | Nonzero and diagnostic on stderr for invalid input, tracked spawn ID, no exact live match, ambiguity, lookup failure, missing tmux, inaccessible terminal or socket, or failed attach. For a spawn ID, include `spawns are headless; use march brood logs <id>` with the actual ID. |
| `march brood sessions` | No positional inputs | Zero exit and labeled live interactive names and tracked spawn IDs on stdout. An empty inventory produces an explicit empty interactive result. | Nonzero and source-specific diagnostic on stderr if a required source fails or times out. Any available stdout results are labeled partial. |

## Integration Boundaries
<!-- audience: builder; mode: reference; length: tables only; diagram: optional; examples: required; applicability: code-shaped features only -->

| Boundary | Request | Result | Failure |
|----------|---------|--------|---------|
| CLI → Brood read API (existing) | Read tracked spawn views through `GET /sessions?kind=spawn`. Include tracked terminal statuses. | Spawn IDs for the display and exact-ID guard. | An unavailable or timed-out read leaves the guard unverified and prevents attach. |
| CLI → Castra (required capability) | Authenticated live inventory of Castra-managed targets advertised under `march/`, or exact lookup by unprefixed name | Inventory entries carry the attach name. Lookup returns the exact tmux target on Castra's server for a single live match, such as `march/conductor`. | Healthy empty inventory succeeds. Unknown or ambiguous lookup fails. Authentication, missing tmux, permission, and service failures surface as errors. |
| Host terminal → Castra-owned tmux server | Attach to the exact resolved target with the caller's terminal attached. | Interactive I/O until detach or session termination. | Missing tmux, inaccessible socket, missing terminal, or target disappearance produces a nonzero result. |

The existing Castra list and show routes expose agent-deck session records. The live inventory and exact target resolution above specify required behavior. See the [Castra contract](../../docs/subsystems/castra/contract.md).
