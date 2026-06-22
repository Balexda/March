#!/usr/bin/env bash
# lib.sh — shared helpers for the march.debug diagnostic scripts.
#
# GENERATED — do not edit. Author the source at
#   src/templates/skills/march.debug/scripts/lib.sh.prompt
# and run `npm run skills:generate` (also runs on `npm run build`).
#
# Execution context: repo — host shell — services are reached on `localhost` via the compose-published ports.
#
# Sourced by every script in this directory. Provides URL resolution, a single
# HTTP-fetch chokepoint (with a fixture-replay hook for tests), and friendly
# error/exit helpers. Side-effect-free; no global state beyond the resolved URLs.
#
# Service base URLs are BAKED for this execution context at generation time —
# there is NO runtime context detection. An explicit MARCH_*_URL env var still
# wins, so the same variant also works against a non-default endpoint:
#   MARCH_HERALD_URL   default http://localhost:8818
#   MARCH_LEGATE_URL   default http://localhost:8787
#   MARCH_CLI          default march
#
# Test-only hook (do NOT set in production):
#   MARCH_DEBUG_REPLAY_DIR  when set, http_get reads <dir>/<segment>.json
#                           instead of curling — segment is the first path
#                           component (e.g. /state -> state.json, /status?... ->
#                           status.json). Lets the test suite run offline. When the
#                           request carries `?profile=<p>`, a per-profile fixture
#                           <segment>.<p>.json is preferred when present (else the
#                           bare <segment>.json) — this lets a fixture model
#                           Herald's server-side per-profile scoping.

set -euo pipefail

# Context-baked defaults (overridable via the matching env var).
HERALD_DEFAULT_URL="http://localhost:8818"
LEGATE_DEFAULT_URL="http://localhost:8787"
MARCH_CLI_DEFAULT="march"

HERALD_URL="${MARCH_HERALD_URL:-$HERALD_DEFAULT_URL}"
HERALD_URL="${HERALD_URL%/}"
LEGATE_URL="${MARCH_LEGATE_URL:-$LEGATE_DEFAULT_URL}"
LEGATE_URL="${LEGATE_URL%/}"

# Exit codes (stable so callers/tests can distinguish error classes):
EX_USAGE=2        # bad flags / missing required arg
EX_UNREACHABLE=4  # service connection refused / DNS / timeout
EX_NOTFOUND=5     # requested resource (sliceId, profile) not present
EX_HTTP=6         # service returned a non-2xx HTTP status

die() { echo "march.debug: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."
}

# columnize — align TSV on stdin into padded columns when util-linux `column` is
# available; otherwise pass the TSV through unchanged. The in-container image
# omits `column`, so callers must degrade gracefully rather than error.
columnize() {
  if command -v column >/dev/null 2>&1; then
    column -t -s$'\t'
  else
    cat
  fi
}

# http_get <base-url> <path-with-optional-query>
# Prints the response body to stdout. Exits EX_UNREACHABLE / EX_HTTP on failure.
http_get() {
  local base="$1" path="$2"
  [ "${path#/}" = "$path" ] && path="/$path"

  if [ -n "${MARCH_DEBUG_REPLAY_DIR:-}" ]; then
    local seg="${path#/}"; seg="${seg%%\?*}"; seg="${seg%%/*}"
    # Prefer a per-profile fixture (<segment>.<profile>.json) when the request is
    # profile-scoped, mirroring Herald's server-side ?profile= filtering; fall
    # back to the bare <segment>.json (single-profile / unscoped fixtures).
    # Match only a real `profile=` query param (anchored on its `?`/`&`
    # delimiter, so `user_profile=` does not), then reject anything that is not a
    # bare profile token — this keeps a crafted `?profile=../..` from traversing
    # out of the fixture dir when building the filename.
    local prof=""
    case "$path" in
      *"?profile="*|*"&profile="*) prof="${path##*profile=}"; prof="${prof%%&*}";;
    esac
    case "$prof" in *[!A-Za-z0-9._-]*) prof="";; esac
    local f="$MARCH_DEBUG_REPLAY_DIR/${seg}.json"
    if [ -n "$prof" ] && [ -f "$MARCH_DEBUG_REPLAY_DIR/${seg}.${prof}.json" ]; then
      f="$MARCH_DEBUG_REPLAY_DIR/${seg}.${prof}.json"
    fi
    if [ -f "$f" ]; then cat "$f"; return 0; fi
    echo "march.debug: replay fixture not found: $f (for $path)" >&2
    return "$EX_UNREACHABLE"
  fi

  need curl
  local body status
  # -w writes the HTTP status on its own trailing line; -s silences progress;
  # we deliberately do NOT use -f so we can read a non-2xx body for diagnostics.
  if ! body=$(curl -sS -m 15 -w $'\n%{http_code}' "${base}${path}" 2>/dev/null); then
    echo "march.debug: ${base} is unreachable (connection refused / timeout)." >&2
    return "$EX_UNREACHABLE"
  fi
  status="${body##*$'\n'}"
  body="${body%$'\n'*}"
  if [ "$status" -lt 200 ] || [ "$status" -ge 300 ]; then
    echo "march.debug: ${base}${path} returned HTTP $status." >&2
    [ -n "$body" ] && echo "$body" >&2
    return "$EX_HTTP"
  fi
  printf '%s' "$body"
}

herald_get() { http_get "$HERALD_URL" "$1"; }
legate_get() { http_get "$LEGATE_URL" "$1"; }
