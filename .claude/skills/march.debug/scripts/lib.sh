#!/usr/bin/env bash
# lib.sh — shared helpers for the march.debug diagnostic scripts.
#
# Sourced by every script in this directory. Provides URL resolution, a single
# HTTP-fetch chokepoint (with a fixture-replay hook for tests), and friendly
# error/exit helpers. Side-effect-free; no global state beyond the resolved URLs.
#
# Env overrides honored by all scripts:
#   MARCH_HERALD_URL       explicit Herald base URL (honored verbatim)
#   MARCH_LEGATE_URL       explicit Legate base URL (honored verbatim)
#   MARCH_HERALD_HOST      Herald's docker-network hostname (default march-herald)
#   MARCH_LEGATE_HOST      Legate's docker-network hostname (default march-legate)
#
# Transport is CONTEXT-AWARE because the skill runs from two places that reach the
# services by DIFFERENT addresses:
#   - On the HOST, the compose stack publishes each service's port to localhost,
#     so the default base is http://localhost:<port>.
#   - INSIDE a container (e.g. an agent-deck session in the Castra container),
#     localhost is the container's OWN loopback; sibling services are reached over
#     the shared docker network by hostname — the SAME addressing the services use
#     to see each other — so the default base is http://<service-host>:<port>.
# An explicit MARCH_*_URL always wins; that is how the compose-managed services
# are configured and the right thing to set for any non-default topology.
#
# Test-only hook (do NOT set in production):
#   MARCH_DEBUG_REPLAY_DIR  when set, http_get reads <dir>/<segment>.json
#                           instead of curling — segment is the first path
#                           component (e.g. /state -> state.json, /status?... ->
#                           status.json). Lets the test suite run offline.

set -euo pipefail

HERALD_HOST="${MARCH_HERALD_HOST:-march-herald}"
LEGATE_HOST="${MARCH_LEGATE_HOST:-march-legate}"

# True when this process is running inside a container, where the host-published
# ports are NOT on our loopback and sibling services must be reached over the
# docker network instead. `/.dockerenv` is the portable marker the Docker runtime
# drops in every container; the embedded-DNS resolver (127.0.0.11) is a secondary
# tell.
in_container() {
  [ -f /.dockerenv ] && return 0
  grep -q '127\.0\.0\.11' /etc/resolv.conf 2>/dev/null
}

# resolve_url <explicit-override> <service-host> <port>
# Honor an explicit override verbatim; otherwise use localhost on the host and the
# docker-network service hostname inside a container (see the transport note above).
resolve_url() {
  local override="$1" host="$2" port="$3"
  if [ -n "$override" ]; then printf '%s' "${override%/}"; return; fi
  if in_container; then printf 'http://%s:%s' "$host" "$port"; return; fi
  printf 'http://localhost:%s' "$port"
}

HERALD_URL="$(resolve_url "${MARCH_HERALD_URL:-}" "$HERALD_HOST" 8818)"
LEGATE_URL="$(resolve_url "${MARCH_LEGATE_URL:-}" "$LEGATE_HOST" 8787)"

# Exit codes (stable so callers/tests can distinguish error classes):
EX_USAGE=2        # bad flags / missing required arg
EX_UNREACHABLE=4  # service connection refused / DNS / timeout
EX_NOTFOUND=5     # requested resource (sliceId, profile) not present
EX_HTTP=6         # service returned a non-2xx HTTP status

die() { echo "march.debug: $*" >&2; exit 1; }

need() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' is required but not installed."
}

# http_get <base-url> <path-with-optional-query>
# Prints the response body to stdout. Exits EX_UNREACHABLE / EX_HTTP on failure.
# The base URL is already context-resolved (localhost on the host, docker-network
# host in a container), so this is a single, honest reach — no socket fallback
# that could mask an unreachable service.
http_get() {
  local base="$1" path="$2"
  [ "${path#/}" = "$path" ] && path="/$path"

  if [ -n "${MARCH_DEBUG_REPLAY_DIR:-}" ]; then
    local seg="${path#/}"; seg="${seg%%\?*}"; seg="${seg%%/*}"
    local f="$MARCH_DEBUG_REPLAY_DIR/${seg}.json"
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
