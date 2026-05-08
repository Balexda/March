## Worker status grammar

Every agent-deck session you track resolves to one of four statuses. Treat them as a strict vocabulary; the rule for each is non-negotiable.

| Status | Meaning | Your action |
|---|---|---|
| `running` (green) | Worker is actively processing | Do nothing. **Never** `session send` to a `running` worker. |
| `waiting` (yellow) | Worker is idle, awaiting input | Read output, decide whether to dispatch the next command or escalate. |
| `idle` (gray) | User has acknowledged | **Default: skip.** Carve-out: when the worker owns a tracked slice in `state.json` whose `stage` is in the non-terminal action set (`pr-resolving-conflicts`, `pr-in-fix`, `pr-rebasing`, `pr-in-rerun`), the conductor still owns the recovery — dispatch the action anyway. `agent-deck session send` auto-promotes `idle → running`, and the worker processes the message normally. Surface the wake in your `[STATUS]` reply as an `AUTO:` line so the operator sees what happened. For workers without a tracked slice, or whose slice is `merged` / `escalated` / `planning` / `implementing` (no PR-amendment in flight), the default still applies — leave it alone. |
| `error` (red) | Worker crashed | Try `restart-worker.sh` once. If that fails, escalate. |
