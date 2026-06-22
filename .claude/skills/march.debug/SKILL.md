---
name: march.debug
description: "Diagnose a running March stack: inspect Herald's fold and event log, compare against the legate's view to surface divergence, read spawn/codex failure logs to find root cause, and execute the break-glass (Herald admin events) or recovery (`march legate recover`) procedures when the fold is wedged. Use when slices are escalated unexpectedly, dispatch appears stuck, the operator suspects a service-side bug, or before/after running any operator-only recovery action."
allowed-tools: Bash(*/march.debug/scripts/fold-state.sh:*) Bash(*/march.debug/scripts/events-tail.sh:*) Bash(*/march.debug/scripts/legate-status.sh:*) Bash(*/march.debug/scripts/dispatch-diag.sh:*) Bash(*/march.debug/scripts/spawn-failure.sh:*) Bash(*/march.debug/scripts/admin-event.sh:*) Bash(*/march.debug/scripts/mass-recover.sh:*) Bash(docker logs march-*) Bash(docker ps*) Bash(docker exec march-legate printenv*) Bash(curl -s http://localhost:8818/*) Bash(curl -s http://localhost:8787/*) Bash(march legate recover *) Bash(march brood sweep*) Bash(march herald admin event*)
---
<!-- GENERATED for the repo execution context — do not edit.
     Author the source at src/templates/skills/march.debug/SKILL.prompt and run
     `npm run skills:generate` (also runs on `npm run build`). -->
# march.debug

Operator-side diagnostics for a **running** March container stack. Everything
here observes or repairs the live system; nothing modifies product code. Scripts
live in this skill's `scripts/` directory — reference them as
`${CLAUDE_SKILL_DIR}/scripts/<name>`. Each is side-effect-free except
`admin-event.sh` (intentionally break-glass; dry-run unless `--yes`).

This skill is the manual equivalent of **Courier** (#270), the planned
notifications service. Until Courier ships, an operator finds out by reading
what the scripts below read.

For the underlying telemetry model (traces, metrics, the deterministic
trace-id-per-slice scheme, dashboards), see
[`docs/Observability.md`](../../../docs/Observability.md) — this skill does not
re-cite it.

---

## When to load this skill

- A slice escalated to **operator-only** and you need to know why before acting.
- Dispatch **appears stuck** — work is queued but nothing is spawning.
- Herald's dashboard / `/state` and your intuition disagree about how much work
  is dispatchable.
- A spawn **failed** and `docker logs` isn't telling you why.
- **Many** slices escalated at once from one transient cause — a host reboot, an
  OOM, a Castra-unreachable window, a codex auth lapse — that is now resolved
  (see *Operation: Mass recovery*).
- You suspect a **service-side bug** left the fold in an unreachable state.
- **Before or after** running any operator-only recovery (`march legate recover`)
  or break-glass (`march herald admin event`) action — diagnose first, verify
  after.

---

## Where everything lives

### Services + ports

This variant is generated for the **repo** execution context:
host shell — services are reached on `localhost` via the compose-published ports. Every programmatic base URL below is baked for that context and
can be overridden with the matching `MARCH_*_URL` env var (an explicit value
always wins). Grafana is a browser endpoint you open from the host, so it stays
on `localhost` regardless of context.

| Service | URL | Notes |
|---|---|---|
| otel-lgtm (Grafana) | http://localhost:3000 | dashboards: `march-legate`, `march-herald`, `march-hatchery` (browser, from the host) |
| OTel collector (OTLP HTTP) | http://localhost:4318 | where services ship traces/metrics/logs; read them via Grafana above |
| Castra | http://localhost:9264 | interactive-session host; `/v1/sessions` carries `branch` (#264) |
| Hatchery | http://localhost:8080 | spawn flow |
| Brood | http://localhost:9748 | session-state + teardown authority |
| Herald | http://localhost:8818 | event log + fold projection |
| Legate loop | http://localhost:8787 | the deterministic two-stage tick, one shared container, N profiles |

### Log files (on the host, NOT inside the container)

| Path | What |
|---|---|
| `~/.march/legate/<profile>/legate.ndjson` | heartbeat / loop events |
| `~/.march/legate/<profile>/legate-heartbeat.ndjson` | per-tick health |
| `~/.march/legate/<profile>/legate-requests.ndjson` | **judgement requests — where the real Hatchery error detail lives when a spawn dies. `docker logs march-legate` will NOT show it.** |
| `~/.march/logs/hatchery-spawns/<spawnId>/spawn-output.log` | the spawn-codex container's stdout (line-delimited JSON from the codex CLI). The auth-refresh failure emits `{"type":"error","message":"Your access token could not be refreshed..."}` here and **only** here. |
| `~/.march/herald/<profile>.db` | Herald's sqlite event log — **read via the `/events` HTTP API, never direct sqlite.** |

### Fold + projection surfaces (HTTP)

| Endpoint | What |
|---|---|
| `GET http://localhost:8818/state` | Herald's current fold projection (bare `SystemState`: `seq`, `smithy{dispatchable,blocked,total}`, `workers`, `slices{}` keyed by sliceId). |
| `GET http://localhost:8818/events?after=<seq>&limit=<n>` | drain past events; `{events:[...], lastSeq}`. Each envelope has `source` = `herald` (observation) or `legate` (transition). |
| `GET http://localhost:8787/status?profile=<p>` | the legate's view of the **same** fold — different in-memory shape, **can diverge** from Herald's projection (see #268). |
| `GET http://localhost:9264/v1/sessions?profile=<p>` | Castra's live session list (carries `branch` per #264). |

### OTel correlation gotcha

March registers **no OTel ContextManager**, so `context.with(...)` /
`getActiveSpan()` do **not** propagate. Logs are correlated to spans by
attaching `trace_id` / `span_id` explicitly (the `emitLoopLog` pattern). Don't
grep Grafana for "the active span" — read the explicit `trace_id`/`span_id`
attributes on the log line. The trace id is deterministic per slice
(`sha256("march.trace:"+sliceId)[:32]`), so you can compute it from a sliceId.

---

## The diagnostic playbook

Run these in order. Each step's script narrows what the next step looks at.

### 1. Is the system actually wedged?

```bash
${CLAUDE_SKILL_DIR}/scripts/dispatch-diag.sh --profile <p>
```

Cross-checks Herald's `smithy.dispatchable` against the legate's
`queue.dispatchable`.

- **Herald > legate** → the **#268 metric-inflation** signature, *not* a
  deadlock. Herald's observation-side count skips the in-flight/archived dedup
  the legate applies, so it over-counts. Trust the legate's number. If the
  legate says `0`, nothing is genuinely ready — stop, you're not wedged.
- **Both 0**, nothing in the smithy queue → nothing to do.
- **Both > 0** and the legate is silent across several ticks (no recent
  legate-source events — check `events-tail.sh --profile <p> --src legate`) → the
  dispatch handler is genuinely not firing. Go to step 2.

### 2. What is the latest dispatch attempt actually doing?

```bash
${CLAUDE_SKILL_DIR}/scripts/spawn-failure.sh --profile <p>          # most recent
${CLAUDE_SKILL_DIR}/scripts/spawn-failure.sh --profile <p> --all    # confirm a shared cause
```

Reads the most recent `hatchery_dispatch_failed` entry from
`legate-requests.ndjson`, extracts the `spawnId` + log path from its `detail`,
and prints the codex CLI's literal error. Pattern-match the message:

| Marker in spawn-output.log | Root cause | Fix |
|---|---|---|
| `refresh token was already used` / `log out and sign in again` | codex OAuth expired | operator re-auths codex (root cause behind #269/#270) |
| `branch already exists` | orphan branch | Brood teardown of the orphan (#155) |
| `git apply` / `patch does not apply` | bad worker patch (truncated / new-file diff) | worker-side recovery |
| exited 1, empty log | broken image / codex CLI startup error | rebuild image / check codex CLI |

Use `--all` when several slices failed in the same minute — if they all show the
same marker, it's one root cause (e.g. one codex auth expiry escalating four
slices), not four problems.

### 3. What is the slice-level state, and is recovery safe?

```bash
${CLAUDE_SKILL_DIR}/scripts/fold-state.sh --slice <sliceId>
```

For each escalated slice, read its fold attributes:

- **`sessionId` empty** (`session=MISSING` in the summary) → the slice→session
  link is missing. The babysit/review-fix path can't run. See step 4
  (admin-event backfill) — this is the #173 / #265 scenario.
- **`escalatedReason`** = `hatchery_dispatch_failed` → step 2's analysis applies.
  Other reasons may need different remediation.
- **`pr`** MERGED → a stale tombstone that hasn't archived yet; usually benign.
  OPEN with `threads=N` → babysit should be sending `/smithy.fix`; if it isn't,
  check the `sessionId` (see #173 / #258).

---

## Operation: Recover an escalated slice

When a slice escalated because the **auto-recovery budget (#211) was exhausted**
and you have **fixed the root cause** (e.g. re-authed codex), request recovery:

```bash
march legate recover <sliceId> [--profile <p>]
```

This appends a `slice.recovery.requested` event to Herald. On the next tick the
legate drops the escalated (tombstoned) slice, clears its retry counter, and
frees the artifact for re-dispatch.

**Diagnose first.** If the root cause is still present (codex still can't auth,
the branch is still orphaned), the slice will just escalate again — you'll burn
another recovery for nothing. Confirm via step 2 that the failure class is
resolved before recovering. `--profile` is optional when only one profile is
registered.

After recovering, watch it re-dispatch:

```bash
${CLAUDE_SKILL_DIR}/scripts/events-tail.sh --profile <p> --slice <sliceId> --src legate
```

## Operation: Mass recovery after a spawn-storm / host reboot

When **many** slices escalated from a **single transient cause that is now
resolved** — a host reboot or OOM that killed every Castra session, a burst that
overran the host, a window where castra was unreachable, a codex auth
lapse — they all carry the same `escalatedReason` (usually
`hatchery_dispatch_failed`) and all sit at retry count 2 = `DISPATCH_RECOVERY_LIMIT`.
This is the bulk sibling of the single-slice recovery above.

**Signature** (confirm before mass-recovering):

- `dispatch-diag.sh` shows dispatchable work but `dispatch_action_count` stays 0
  across ticks, and `slices_by_stage.escalated` is large.
- `spawn-failure.sh --profile <p> --all` shows **one shared marker** across the
  failures (e.g. `Could not reach Castra` for a whole minute) — one root cause,
  not N problems.
- Often paired with **dead sessions**: Castra `/v1/sessions` returns far fewer
  (or zero) live sessions than the fold's `workers.waiting` count, and
  `legate.ndjson` is churning `ghost-cleanup-failed` (the fold still references
  sessions the reboot destroyed).

**Recover all of them with one command** — dry-run first, then `--yes`:

```bash
export MARCH_HERALD_URL=http://localhost:8818
${CLAUDE_SKILL_DIR}/scripts/mass-recover.sh                       # dry run: prints the plan
${CLAUDE_SKILL_DIR}/scripts/mass-recover.sh --yes                 # recover every escalated slice
${CLAUDE_SKILL_DIR}/scripts/mass-recover.sh --profile smithy --reason hatchery_dispatch_failed --yes
```

It enumerates `stage==escalated` slices from Herald's fold and appends a
`slice.recovery.requested` for each — the same mechanism as the single-slice
operation, just batched.

- **Cap (always enforced):** re-dispatch is paced by the legate's global
  concurrency cap (#313) whether or not `MARCH_MAX_CONCURRENT_SPAWNS` is set — an
  unset/invalid value resolves to the built-in default of **10** — so bulk
  recovery can't re-storm the host. With `--yes` the script just reports the
  effective cap (and notes when the default applies); it never blocks on it.
  `spawn_cap_throttled` events appear if the dispatchable frontier exceeds the cap.
- **No manual git is needed.** A re-dispatch whose orphan branch/worktree still
  exists collides at `manager.launch` ("branch already exists"); the Hatchery
  **self-heal (#243, `src/hatchery/orphan-branch.ts`)** classifies the orphan and,
  when it is safe (HEAD is an ancestor of the default branch — no unique commits —
  or its PR already merged), removes the **worktree then the branch by exact path**
  (#155, never `git worktree prune`). The first attempt collides + self-heals +
  escalates; **#211 auto-recovery retries into the now-clean state and succeeds**.
  An **unsafe** orphan (diverged unmerged work, or an open PR — #173's adopt path)
  is left in place and that slice stays operator-only: handle it with the
  `legate.unwedge` skill, not here.
- **Companion — sweep leaked stewards.** The reboot also leaks steward rows whose
  PR already merged but whose worktree/branch were never torn down. Reap them:

  ```bash
  march brood sweep   # needs MARCH_BROOD_ADMIN_TOKEN
  ```

  Caveats: `POST /admin/sweep` **does not honor a `dryRun` body — it always
  acts**. It only reaps stewards it can prove are done — `pr-merged` /
  `pr-closed` / `worktree-gone`; it deliberately **skips `no-pr`** (the
  failed-spawn ghosts — those are cleared by the self-heal above when their slice
  re-dispatches) and **`open-pr`** (still live).

**Verify** the backlog drains (escalated → 0, slices flow to
`hatchery-pending`/`implementing`/`pr-open`, orphan worktrees fall as each
re-dispatches):

```bash
${CLAUDE_SKILL_DIR}/scripts/events-tail.sh --profile <p> --src legate   # slice.dispatched / slice.recovery.dispatched
curl -s "$MARCH_HERALD_URL/state?profile=<p>" | jq .smithy
```

> The residual ghost-cleanup churn and merged-but-unarchived `pr-open` tombstones
> come from the steward-leak re-keying bug (#304/#310): on a stack built before
> #310 they are harmless dashboard noise the running services cannot self-clear.
> Redeploying the stack from `main` (#310 `reconcileBrood`, #155 exact-path
> teardown, #316 castra-recover) clears them — that is a deploy action, not a
> `march.debug` operation.

## Operation: Break-glass admin event

For inserting a corrective event the running services **cannot author
themselves** — a since-fixed bug left the fold holding wrong data and no code
path can reach the correct state (#265).

```bash
${CLAUDE_SKILL_DIR}/scripts/admin-event.sh \
  --profile <p> --type <eventType> --note "<why>" [event-fields...] [--yes]
```

`admin-event.sh` wraps `march herald admin event` with safer defaults: it always
echoes the body and the break-glass banner, and runs as a **dry run unless
`--yes`** is passed.

- **Auth gate:** requires `MARCH_HERALD_URL` and `MARCH_HERALD_ADMIN_TOKEN`. The
  `/admin/events` route **404s** when the token env is unset (by design — the
  endpoint is invisible in environments that didn't opt in). Set the admin token
  only while intervening, then unset it again.
- **Audit:** each append gets a real `seq` from Herald's single sequencer, is
  validated against the same reducer the normal `/events` path uses, and writes
  a paired `admin.event.appended` audit row (visible in `events-tail.sh`, where
  the appended event shows an `ADMIN` marker).
- **Warm-fold guarantee (#265):** the legate folds incremental events (e.g.
  `slice.steward.attached`) into its running working state — **no legate restart
  is needed**. The next tick picks it up.

**Most common recipe — the slice→session link backfill** (the #230/#240 legacy
slices that predate the #213 Hatchery push, so no `slice.steward.attached` was
ever emitted and `babysit.assess` skips them):

```bash
export MARCH_HERALD_URL=http://localhost:8818
export MARCH_HERALD_ADMIN_TOKEN=<token>      # set only for the intervention

${CLAUDE_SKILL_DIR}/scripts/admin-event.sh \
  --profile march --type slice.steward.attached \
  --slice-id 01-spawn-f5-s2-cut \
  --session-id e3bde73d-1779515948 \
  --worktree-path /home/jmbattista/Development/WorkTrees/March/feature-smithy-cut-01-spawn-f5-s2 \
  --branch smithy/cut/01-spawn-f5-s2 \
  --note "legacy slice pre-#213; sessionId via agent-deck worktreePath match; unstick PR #240" \
  --yes

unset MARCH_HERALD_ADMIN_TOKEN
```

The live `sessionId` is discovered by matching the slice's `worktree-path`
against agent-deck's session list (Castra `/v1/sessions`). Verify afterward:

```bash
${CLAUDE_SKILL_DIR}/scripts/fold-state.sh --slice 01-spawn-f5-s2-cut   # sessionId now set
```

**Caution:** this is for *"the bug that left this state is fixed but the data is
wrong"* — **not** for ongoing flow control. If you find yourself reaching for
admin-event regularly, the bug isn't fixed; fix the bug instead.

---

## What this skill does NOT do

- **Does not modify code.** Diagnostic + recovery only; the product is the thing
  being observed.
- **Does not run destructive git by hand.** No `git reset --hard`, no
  `git branch -D`, no worktree surgery from this skill. Orphan-branch / worktree
  cleanup is **not manual** — `march legate recover` / `mass-recover.sh` lets the
  Hatchery self-heal (#243) remove safe orphans by exact path on re-dispatch, and
  teardown routes through Brood (exact-path, never-prune, #155). If an orphan is
  *unsafe* (diverged / open-PR), that is the `legate.unwedge` skill or #173's
  adopt path — not a manual `branch -D` here.
- **Does not implement the operator notifier.** That's Courier (#254 / #270);
  this skill is the manual stand-in until it ships.
- **Does not invent diagnostics.** Every pattern here was proven during real
  dogfooding incidents (#173/#258 stuck session link, #265 warm-fold gap, #268
  metric inflation, #269/#270 codex auth escalation).
