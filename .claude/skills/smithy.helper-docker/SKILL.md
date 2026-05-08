---
name: smithy.helper-docker
description: "Diagnose and recover from Docker container failures. Use when a docker run/compose command appears stuck, a container exits unexpectedly, or validation steps fail with docker-related errors."
---
# smithy.helper-docker

Procedures for handling Docker container failures during smithy workflows
(typically encountered by `smithy.forge` during the build/test/validation
phases). Use this skill when:

- A `docker run`, `docker compose up`, or test command depending on docker has
  been waiting more than ~60 seconds without progress.
- A container has exited unexpectedly, is restart-looping, or reports an
  `unhealthy` healthcheck.
- A test suite that boots services (testcontainers, ryuk, sidecar databases,
  etc.) is failing to start its dependencies.
- The docker daemon itself is unreachable.

Do **not** load this skill for unrelated build, lint, or test failures that
mention docker only peripherally — keep the context lean.

---

## Operation: Bound the wait

Never wait for a container indefinitely. When starting docker workloads,
attach an explicit timeout so a stuck container fails fast with a diagnostic
signal.

```bash
# Compose: --wait blocks until services are healthy; --wait-timeout caps it.
docker compose up --detach --wait --wait-timeout 60

# Single run with an external timeout and exit-code capture:
timeout 60 docker run --rm <image> <command>
echo "exit=$?"
```

Recommended budgets:

| Operation | Default timeout |
|-----------|-----------------|
| `docker pull` | 120s (network-bound) |
| `docker compose up --wait` | 60s |
| Healthcheck-gated start | 90s |
| Single `docker run` for tests | 120s |

If the timeout fires, **stop**. Do not blindly retry — gather diagnostics
first.

---

## Operation: Diagnose a stalled or failed container

When a container did not become healthy in time, run these commands in order
and capture the output. Whether you recover or escalate, the user will need
this information.

```bash
# 1. Status of all containers (running and exited)
docker ps -a

# 2. The container's state plus restart count. `RestartCount` is a top-level
#    field on the inspect object (not nested under `.State`), so pull both.
docker inspect <name-or-id> | jq '.[0] | {State, RestartCount}'

# 3. Recent logs (last 200 lines, stdout + stderr)
docker logs --tail 200 <name-or-id>

# 4. If using compose, check service-level state and logs
docker compose ps
docker compose logs --tail=200 <service>
```

Quick triage from the `.State` JSON returned by `docker inspect`:

| Signal | Likely cause | Action |
|--------|--------------|--------|
| `ExitCode: 0`, `Status: exited` | Process exited cleanly (no daemon, missing CMD, one-shot finished) | Check Dockerfile / compose `command` |
| `ExitCode: 125` | Daemon-side error (port bind, mount, permission) | Read the engine error in `Error` |
| `ExitCode: 137` | OOM-killed | Raise memory limit or fix leak |
| `ExitCode: 1` + crash logs | App-level error | Read `docker logs` and fix the app |
| `RestartCount >= 3` | Restart loop | Stop the container; do not retry |
| `Health.Status: unhealthy` | Healthcheck failing | Read `Health.Log[-1].Output`; fix the probe target |

---

## Operation: Recover or escalate

After diagnostics, choose one path. **Never silently retry the same command.**

**Recover** (only if the cause is mechanical and locally fixable):

- Port conflict (`bind: address already in use`) → free the port or remap, retry **once**.
- Stale container name (`name already in use`) → `docker rm -f <name>`, retry **once**.
- Missing image → `docker pull <image>` (with timeout), retry **once**.

**Escalate to the user** when:

- `RestartCount >= 3`.
- An app-level crash that requires code changes.
- An unrecognised exit code or daemon error.
- Two recovery attempts have already been made.

When escalating, include in the report:

- The command that failed and how long it ran.
- The container's `.State` JSON and the last 50 lines of logs.
- The proximate cause if you can identify it from the logs.

---

## Operation: Pre-flight check

Before kicking off a validation suite that you suspect needs docker, run a
quick pre-flight to fail fast on environment issues rather than mid-test:

```bash
# Daemon reachable?
docker info >/dev/null 2>&1 && echo "ok" || echo "daemon not running"

# Disk pressure (>90% used can cause silent failures)
docker system df
```

If the daemon isn't running, **stop and ask the user** — do not try
`sudo systemctl start docker` or similar autonomously. That is a host-level
change and out of scope.
