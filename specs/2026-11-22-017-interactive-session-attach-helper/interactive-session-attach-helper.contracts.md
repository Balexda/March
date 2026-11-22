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
| CLI → Castra live inventory (required capability) | Authenticated list of live Castra-managed targets advertised under `march/` | Zero or more entries, each carrying its unprefixed attach name, for example `conductor`. A healthy empty inventory is a successful empty result. | Authentication, missing tmux, permission, timeout, and service failures surface as errors, never as an empty result. |
| CLI → Castra exact target lookup (required capability) | Authenticated lookup by one unprefixed attach name | For exactly one live match, the exact tmux target on Castra's server, such as `march/conductor`. | Unknown and ambiguous names fail without returning a target. Authentication, missing tmux, permission, timeout, and service failures surface as errors. |
| Host terminal → Castra-owned tmux server | Attach to the exact resolved target with the caller's terminal attached. | Interactive I/O until detach or session termination. | Missing tmux, inaccessible socket, missing terminal, or target disappearance produces a nonzero result. |

The existing Castra list and show routes expose agent-deck session records. Both capabilities above are required: `march brood sessions` depends on the inventory, and `march brood attach` depends on the lookup. The inventory does not replace the lookup. See the [Castra contract](../../docs/subsystems/castra/contract.md).
