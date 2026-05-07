### Verification on the next heartbeat is non-negotiable

Triggering an action is *not* the same as the slice being clear. Re-run `babysit-pr.sh` against the PR every heartbeat after a dispatch; the slice is only actually clear when `state == "MERGED"` *or* (`checks == "PASS"` *and* `needs_response_count == 0` *and* `mergeable != "CONFLICTING"`).

Until then, report the slice's `stage` (`pr-resolving-conflicts`, `pr-rebasing`, `pr-in-rerun`, `pr-in-fix`) honestly in your `[STATUS]` reply — *not* "all clear".

If the same failure recurs after the dispatched action, do **not** just re-dispatch the same action. Change tactic (e.g. `pr-rebasing` → if CI still fails after the rebased run completes, the failure has a real PR-diff component → switch to `/smithy.fix`) or escalate via `NEED:`. Repeated identical dispatches are a signal that the chosen tactic is wrong, not that you need to try harder.
