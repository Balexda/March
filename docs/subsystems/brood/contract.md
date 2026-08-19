# Brood Contract

## Purpose

Brood owns lifecycle state and cleanup for tracked March sessions. Its read
surfaces give operators and automation visibility without moving registry,
Docker, archive, worktree, branch, or Castra mutation into the CLI. This follows
the Brood role in `docs/vision.md` and `docs/operating-philosophy.md`: Brood is
the lifecycle authority, while the CLI is only the deliberate intervention
surface over that authority.

## Public Interface

<!-- BEGIN AUTOGEN -->
<!-- END AUTOGEN -->

### `GET /sessions/:id/logs`

`GET /sessions/:id/logs` returns logs for one tracked `SessionRecord`.

| Condition | Response |
|-----------|----------|
| Live container logs are readable for a container-backed `spawn` or `legate` row | `200 text/plain` with `X-March-Log-Source: live-container` |
| Live container logs are missing or unreadable and `<home>/.march/brood/archive/<id>/container.log` is readable | `200 text/plain` with `X-March-Log-Source: archive` |
| The id is not tracked | `404 { "error": "No session with id \"<id>\"." }` |
| No live source and no readable archive exist | `409 { "error": "<message>" }` |
| The live container read fails and no readable archive exists | `502 { "error": "<message>" }` |

The endpoint is read-only. It may call the Docker log read path and read the
archived `container.log`, but it must not register, update, delete, tear down,
prune, remove, create, or repair registry rows, Docker resources, archives,
worktrees, or branches.

Steward live-session output is intentionally not part of this slice. A steward
row can still use archived `container.log` when present; live Castra session
output is owned by the follow-up steward log-routing contract.

## Invariants

- Log reads are read-only. They do not register, update, delete, tear down,
  prune, remove, create, or repair registry rows, Docker resources, archives,
  worktrees, or branches.
- Container-backed `spawn` and `legate` records prefer the tracked live
  container log source when it can be read.
- Archive fallback reads only the tracked session's archived `container.log`.
- Unknown ids are distinct from known sessions whose logs are unavailable.

## Error Modes

| Condition | Route | Response | Observable behavior |
|-----------|-------|----------|---------------------|
| Unknown session id | `GET /sessions/:id/logs` | `404` with `{ "error": string }` | No tracked row exists for the id. |
| No live source and no readable archive | `GET /sessions/:id/logs` | `409` with `{ "error": string }` | The session is tracked, but logs cannot be selected. |
| Live container read fails and no readable archive exists | `GET /sessions/:id/logs` | `502` with `{ "error": string }` | The service reports upstream live-log read context and does not attempt local mutation. |
