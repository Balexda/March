# Statio contract

## Public Interface

Statio serves repository metadata, PR lists and details, and unresolved review
threads through its read-only HTTP gateway. See the
[Statio HTTP and client contracts](../../../specs/2026-05-26-006-statio-forge-gateway/statio-forge-gateway.contracts.md)
for routes, response shapes, and bearer authentication.

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

### GitHub access

| Setting | Behavior |
| --- | --- |
| `MARCH_STATIO_REPO_DIR` | Compose working directory. Statio resolves the GitHub `origin` from this checkout or worktree before contacting Tessera or GitHub. An in-process caller can supply a known repository slug to the metadata reader or adapter. |
| `MARCH_TESSERA_URL` | Tessera base URL. Compose defaults to the Tessera service on the shared network, port 9477 unless `MARCH_TESSERA_PORT` is set. |
| `MARCH_TESSERA_CLIENT_KEY` | Statio's registered client key. Compose supplies it from `MARCH_STATIO_TESSERA_CLIENT_KEY`. Tessera policy must grant `statio` app/read for the repository. |
| `MARCH_TESSERA_GH_TOKEN_FALLBACK` | Set to `1` to enable the shared client's explicit migration fallback when issuance fails. Disabled by default. |

## Invariants

Statio targets the resolved repository explicitly in every `gh` command. Each
child receives its token through `GH_TOKEN` and gets an initially empty,
temporary `GH_CONFIG_DIR`, which Statio removes after the command. Commands
have timeouts and retry once with a refreshed entitlement on a confirmed
GitHub HTTP 401. This follows the [March vision](../../vision.md) and
[operating philosophy](../../operating-philosophy.md).

## Error Modes

Repository discovery and entitlement failures surface as HTTP 502
`forge_error` on forge routes. The bounded `/status` probe reports
`gh.reachable: false` on failure. Operation spans record failures, using the
deterministic slice trace when a valid `x-march-slice-id` is supplied. Statio
also forwards that slice ID on issuance requests to Tessera.
