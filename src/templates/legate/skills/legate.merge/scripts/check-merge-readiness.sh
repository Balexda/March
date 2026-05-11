#!/usr/bin/env bash
# legate skill: structured merge-readiness check for the merge gate.
#
# One `gh api graphql` query (preceded by a single `gh repo view` to resolve
# owner/name) returns everything needed: state, mergeable, mergeStateStatus,
# statusCheckRollup, reviewDecision, reviews (with author type and per-review
# state), and headRefOid (to pin --match-head-commit on the merge call). We
# go through GraphQL because `mergeStateStatus` is not exposed via `gh pr
# view --json` — that field is required to enforce the repo's own merge
# rules without us having to re-derive them. The merge skill applies its
# gate to this single document rather than fanning out across multiple gh
# calls; that keeps the heartbeat pass cheap and the readiness snapshot
# atomic.
#
# The gate is the user's spec: only emit ready_to_merge=true when ALL of
#   - state == OPEN
#   - mergeable == MERGEABLE         (no conflicts)
#   - mergeStateStatus == clean      (GitHub permits merge under repo's own rules)
#   - checks == PASS                 (all CI checks passing — mini-legate's floor)
#   - human_approval_count >= 1      (≥1 non-bot APPROVED review)
#   - changes_requested_count == 0   (no outstanding human CR)
# Every gate failure is enumerated in `blocking_reasons` for the conductor's
# operator-facing reply.
#
# Usage:
#   check-merge-readiness.sh <repo-path> <pr-num>
#
# Stdout: JSON
#   {
#     "number": N,
#     "url": "...",
#     "head_sha": "...",
#     "state": "OPEN|MERGED|CLOSED",
#     "mergeable": "MERGEABLE|CONFLICTING|UNKNOWN",
#     "merge_state_status": "clean|blocked|behind|dirty|draft|unstable|has_hooks|unknown",
#     "checks": "PASS|FAIL|PENDING|NONE",
#     "review_decision": "APPROVED|CHANGES_REQUESTED|REVIEW_REQUIRED|null",
#     "human_approval_count": N,
#     "changes_requested_count": N,
#     "ready_to_merge": true|false,
#     "blocking_reasons": ["..."]
#   }
#
# Exit: 0 success / 1 gh call failed / 2 invalid input.
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: check-merge-readiness.sh <repo-path> <pr-num>" >&2
  exit 2
fi

REPO="$1"
PR="$2"

if [[ ! -d "$REPO/.git" && ! -f "$REPO/.git" ]]; then
  echo "not a git repo: $REPO" >&2
  exit 2
fi
if ! [[ "$PR" =~ ^[0-9]+$ ]]; then
  echo "pr-num must be a positive integer: $PR" >&2
  exit 2
fi

cd "$REPO"

# `mergeStateStatus` is a top-level field on PullRequest in GraphQL but is
# *not* exposed via `gh pr view --json` flags. Use `gh api graphql` for the
# full snapshot in one call. Reviews come back ordered oldest→newest; we
# reduce per-author to the latest non-COMMENTED state so a stale
# CHANGES_REQUESTED that was later superseded by an APPROVED doesn't block.
OWNER_REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
OWNER="${OWNER_REPO%%/*}"
NAME="${OWNER_REPO##*/}"

SNAPSHOT="$(gh api graphql \
  -F owner="$OWNER" \
  -F name="$NAME" \
  -F pr="$PR" \
  -f query='
query($owner: String!, $name: String!, $pr: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $pr) {
      number
      url
      state
      mergeable
      mergeStateStatus
      reviewDecision
      headRefOid
      commits(last: 1) {
        nodes {
          commit {
            statusCheckRollup {
              contexts(first: 100) {
                nodes {
                  __typename
                  ... on CheckRun {
                    name
                    status
                    conclusion
                  }
                  ... on StatusContext {
                    context
                    state
                  }
                }
              }
            }
          }
        }
      }
      reviews(first: 100) {
        nodes {
          state
          submittedAt
          author { login __typename }
        }
      }
    }
  }
}')"

# The `__typename` on author lets us distinguish `User` (human) from `Bot`
# without a per-login allowlist — Copilot Pull Request reviews come back as
# Bot. We further treat any author whose login ends in `[bot]` as a bot
# (covers GitHub Apps that present as Users), which matches how GitHub's UI
# labels them. Per-author latest-non-COMMENTED logic: COMMENTED reviews are
# benign and should not override a prior APPROVED/CHANGES_REQUESTED.
echo "$SNAPSHOT" | jq '
  .data.repository.pullRequest as $pr
  | ($pr.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes // []) as $checks_raw
  | ($pr.reviews.nodes // []) as $reviews_raw
  | (
      $reviews_raw
      | map(. + {
          is_bot: ((.author.__typename == "Bot") or ((.author.login // "") | endswith("[bot]")))
        })
      | map(select(.is_bot == false))
      | map(select(.state != "COMMENTED" and .state != "PENDING" and .state != "DISMISSED"))
      | sort_by(.submittedAt)
      | group_by(.author.login)
      | map(.[-1])
    ) as $latest_per_human
  | ($latest_per_human | map(select(.state == "APPROVED")) | length) as $approvals
  | ($latest_per_human | map(select(.state == "CHANGES_REQUESTED")) | length) as $crs
  | (
      if ($checks_raw | length) == 0 then "NONE"
      elif any($checks_raw[]; .conclusion == "FAILURE" or .conclusion == "TIMED_OUT" or .conclusion == "ACTION_REQUIRED" or .conclusion == "CANCELLED" or .state == "FAILURE" or .state == "ERROR")
        then "FAIL"
      elif any($checks_raw[]; .status == "IN_PROGRESS" or .status == "QUEUED" or .status == "PENDING" or .state == "PENDING")
        then "PENDING"
      else "PASS"
      end
    ) as $checks
  | (($pr.mergeStateStatus // "UNKNOWN") | ascii_downcase) as $mss
  | [
      (if $pr.state != "OPEN" then "state=" + ($pr.state // "null") else null end),
      (if $pr.mergeable != "MERGEABLE" then "mergeable=" + ($pr.mergeable // "null") else null end),
      (if $checks != "PASS" then "checks=" + $checks else null end),
      (if $mss != "clean" then "mergeStateStatus=" + $mss else null end),
      (if $approvals < 1 then "no human approval (" + ($approvals | tostring) + " approvals from non-bot reviewers)" else null end),
      (if $crs > 0 then "outstanding changes-requested (" + ($crs | tostring) + " unresolved)" else null end)
    ] as $reasons
  | ($reasons | map(select(. != null))) as $blocking_reasons
  | {
      number: $pr.number,
      url: $pr.url,
      head_sha: $pr.headRefOid,
      state: $pr.state,
      mergeable: $pr.mergeable,
      merge_state_status: $mss,
      checks: $checks,
      review_decision: $pr.reviewDecision,
      human_approval_count: $approvals,
      changes_requested_count: $crs,
      ready_to_merge: ($blocking_reasons | length == 0),
      blocking_reasons: $blocking_reasons
    }
'
