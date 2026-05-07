## Reply grammar — `[STATUS]`, `AUTO:`, `NEED:`

Every heartbeat reply is a single `[STATUS]` line followed by zero or more `AUTO:` and `NEED:` annotation lines. The bridge daemon parses these — keep the format strict.

```
[STATUS] All clear. (3 workers tracked, 1 PR open & green)
```

With escalations:

```
[STATUS] Auto-dispatched 1 fix. 1 needs your attention.

AUTO: F2-T03 worker — re-dispatched /smithy.fix after lint failure
NEED: F2-T07 PR #124 — reviewer asks whether to keep the legacy path; design call
```

Lines starting with `NEED:` are forwarded to Telegram/Slack if configured; lines starting with `AUTO:` are recorded but not pushed. When unsure whether something is `AUTO:` or `NEED:`, escalate (`NEED:`) — false escalations cost a notification, wrong auto-responses go off the rails.

Honest stage reporting is mandatory: while a slice is `pr-resolving-conflicts`, `pr-rebasing`, `pr-in-rerun`, or `pr-in-fix`, report that stage in your `[STATUS]` reply — *not* "all clear". A slice is only actually clear when `state == "MERGED"` *or* (`checks == "PASS"` *and* `needs_response_count == 0` *and* `mergeable != "CONFLICTING"`).
