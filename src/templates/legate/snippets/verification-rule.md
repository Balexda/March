### Verification on the next heartbeat is non-negotiable

Triggering an action is *not* the same as the slice being clear. Re-run `babysit-pr.sh` against the PR every heartbeat after a dispatch; the slice is only actually clear when `state == "MERGED"` *or* (`checks == "PASS"` *and* `needs_response_count == 0` *and* `mergeable != "CONFLICTING"`).

Until then, report the slice's `stage` (`pr-resolving-conflicts`, `pr-rebasing`, `pr-in-rerun`, `pr-in-fix`) honestly in your `[STATUS]` reply — *not* "all clear".

If the same failure recurs after the dispatched action, do **not** just re-dispatch the same action. Change tactic (e.g. `pr-rebasing` → if CI still fails after the rebased run completes, the failure has a real PR-diff component → switch to `/smithy.fix`) or escalate via `NEED:`. Repeated identical dispatches are a signal that the chosen tactic is wrong, not that you need to try harder.

### When to escalate vs. change tactic

The "change tactic or escalate" choice is structured. Apply this hierarchy in order; only fall through when the previous step has been actually tried in the current heartbeat:

1. **Tactics are distinct.** A failure under one action does **not** prove a different action will fail. `request-rebase.sh` (clean rebase, push) and `request-conflict-resolution.sh` (rebase + resolve + push) are different commands the worker will run; a deny on one may not apply to the other, and a deny rule that was active 24 hours ago may have been transient or since lifted. **Try each distinct tactic at most once per (slice, condition) tuple** — if `request-rebase.sh` failed earlier on a `pr-rebasing` stage but the slice is now `pr-resolving-conflicts`, that's a different condition and the new tactic deserves its own attempt.

2. **State.json notes are summaries, not authoritative.** `last_action_note` records what *one heartbeat* observed; it is not a permanent prediction. Before escalating any action that has a prior `last_action_note` describing a failure, re-check both:
   - The worker's current `agent-deck session output` (covered by the read allow-list) — the worker's most recent reply may say the prior failure was actually resolved (e.g. "rebase succeeded, push completed").
   - The actual git state of the worktree vs. the PR's head SHA on origin — if `git rev-parse HEAD` in the worker's worktree matches `gh pr view --json headRefOid`, the prior push *did* land regardless of what `last_action_note` said.

   A `mergeable=CONFLICTING` state on a slice whose worktree and origin head match means the PR's branch *is* on origin but main has moved past the rebase point — exactly the situation `request-conflict-resolution.sh` is built for.

3. **Escalate via `NEED:` only after the current heartbeat has tried the relevant tactic and verified it failed.** Don't escalate based solely on a stale `last_action_note` from a previous heartbeat or a different action. If you find yourself writing "would hit the same wall" or "same failure would recur" without having actually attempted the new tactic in this heartbeat, stop — that's the protocol gap this rule closes. Try the new tactic; if it fails, *then* escalate with the fresh failure as the basis.
