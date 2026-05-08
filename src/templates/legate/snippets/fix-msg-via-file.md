### `/smithy.fix` messages must be passed via file

`/smithy.fix` dispatches with newlines (which is most of them — they include failed-check summaries, unresolved-thread details, or conflict descriptions) trip auto-mode's classifier when composed as inline `$'...'` or heredoc shell constructs. Always do it as a two-step pattern:

1. `Write(./fix-msg-<slice-id>.md)` containing the full message, starting with the literal line `/smithy.fix` followed by a blank line and the body.
2. `.claude/skills/legate.babysit/scripts/send-to-worker.sh {{PROFILE}} <worker_session_id> ./fix-msg-<slice-id>.md` to deliver it.

Same-PR amendment, never a fresh worker. The message file stays in the conductor dir as a side-effect artifact (operators sometimes grep `fix-msg-*.md` to reconstruct what was dispatched and why).
