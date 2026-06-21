#!/usr/bin/env bash
# mass-recover.sh — batch-recover every escalated slice after a transient
# outage (the spawn-storm / host-reboot class: many slices share one root
# cause that is now resolved). Wraps `march legate recover` so an operator
# does not script the per-slice loop by hand.
#
# It is the bulk sibling of "Operation: Recover an escalated slice": same
# `slice.recovery.requested` mechanism, same "diagnose first" contract — it just
# enumerates `stage==escalated` slices from Herald's fold and recovers each.
#
# SAFETY: dry-run unless `--yes`. Re-dispatch is always paced by the legate's
# GLOBAL concurrency cap (#313) — MARCH_MAX_CONCURRENT_SPAWNS, or its built-in
# default of 10 when unset/invalid — so bulk recovery can't re-storm the host.
# Before acting it just reports the effective cap. No manual git is needed
# afterward: the hatchery self-heal (#243) removes a colliding orphan
# worktree+branch (when ahead==0 / merged) and #211 auto-recovery retries into
# the clean state.
#
# Usage:
#   mass-recover.sh [--profile <p>] [--reason <substr>] [--yes]
#
# Flags:
#   --profile <p>     Only this profile. Default: every registered profile.
#   --reason <substr> Only recover slices whose escalatedReason CONTAINS this
#                     substring (e.g. hatchery_dispatch_failed). Default: all.
#   --yes             Actually recover. Omit for a dry run (prints the plan).
#
# Env:
#   MARCH_HERALD_URL  Herald fold + recover target (default baked per context).
#   MARCH_CLI         march executable (default baked per context).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib.sh
source "$SCRIPT_DIR/lib.sh"

PROFILE=""
REASON=""
APPLY=0
while [ $# -gt 0 ]; do
  case "$1" in
    --profile) PROFILE="${2:?}"; shift 2;;
    --reason)  REASON="${2:?}"; shift 2;;
    --yes)     APPLY=1; shift;;
    -h|--help) sed -n '2,30p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 0;;
    *) die "unknown flag: $1 (see --help)";;
  esac
done

need jq
MARCH_CLI="${MARCH_CLI:-$MARCH_CLI_DEFAULT}"

# Resolve the profile list (one explicit, or all registered).
if [ -n "$PROFILE" ]; then
  PROFILES="$PROFILE"
else
  PROFILES="$(herald_get "/profiles" | jq -r '[.profiles[].profile] | join(" ")')"
fi
[ -n "${PROFILES// }" ] || die "no profiles found (set --profile or check MARCH_HERALD_URL)."

# --- Cap report (re-dispatch is always paced; this is informational) -------
# The legate enforces the global spawn cap (#313) regardless of this env var —
# an unset/invalid value resolves to the built-in default (10) — so bulk recovery
# can never re-storm. Just surface the effective cap; never block on it.
if [ "$APPLY" -eq 1 ]; then
  cap="$(docker exec march-legate printenv MARCH_MAX_CONCURRENT_SPAWNS 2>/dev/null || true)"
  if [ -z "$cap" ]; then
    echo "march.debug: MARCH_MAX_CONCURRENT_SPAWNS not set on march-legate — the legate paces re-dispatch with its built-in default cap (10). Proceeding."
  else
    echo "march.debug: global spawn cap = $cap concurrent (re-dispatch is paced; no re-storm)."
  fi
fi

total=0
for p in $PROFILES; do
  # Pull stage==escalated sliceIds (+reason) from the fold for this profile.
  # jq emits one "<sliceId>\t<reason>" line per match; the --reason filter is a
  # substring (contains) test, matching the legacy behaviour.
  mapfile -t rows < <(herald_get "/state?profile=$p" | jq -r --arg reason "$REASON" '
    (.slices // {})
    | to_entries[]
    | select(.value.stage == "escalated")
    | (.value.escalatedReason // "") as $er
    | select($reason == "" or ($er | contains($reason)))
    | "\(.key)\t\($er)"')

  [ "${#rows[@]}" -eq 0 ] && { echo "[$p] no escalated slices match."; continue; }
  echo "[$p] ${#rows[@]} escalated slice(s):"
  for row in "${rows[@]}"; do
    sid="${row%%$'\t'*}"; er="${row#*$'\t'}"
    total=$((total + 1))
    if [ "$APPLY" -eq 1 ]; then
      if out="$($MARCH_CLI legate recover "$sid" --profile "$p" 2>&1)"; then
        echo "  OK   $sid  ($(echo "$out" | grep -o 'seq=[0-9]*' || echo recovered))"
      else
        echo "  FAIL $sid :: $out"
      fi
    else
      echo "  would recover  $sid  [${er:-?}]"
    fi
  done
done

echo "---"
if [ "$APPLY" -eq 1 ]; then
  echo "Requested recovery of $total slice(s). Watch them drain:"
  echo "  ${CLAUDE_SKILL_DIR:-$SCRIPT_DIR}/events-tail.sh --src legate"
  echo "  curl -s \"\$MARCH_HERALD_URL/state?profile=<p>\"   # escalated count should fall to 0"
else
  echo "DRY RUN — $total slice(s) would be recovered. Re-run with --yes to act."
fi
