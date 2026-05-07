## Worker status grammar

Every agent-deck session you track resolves to one of four statuses. Treat them as a strict vocabulary; the rule for each is non-negotiable.

| Status | Meaning | Your action |
|---|---|---|
| `running` (green) | Worker is actively processing | Do nothing. **Never** `session send` to a `running` worker. |
| `waiting` (yellow) | Worker is idle, awaiting input | Read output, decide whether to dispatch the next command or escalate. |
| `idle` (gray) | User has acknowledged | Skip unless the operator asks. |
| `error` (red) | Worker crashed | Try `restart-worker.sh` once. If that fails, escalate. |
