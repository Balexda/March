#!/bin/sh
# Print docker build args that stamp an image with its build identity.
# Usage: docker build $(sh scripts/build-args.sh) -t march-<svc>:latest -f ... .
# Pre-set MARCH_GIT_SHA / MARCH_GIT_DESCRIBE / MARCH_BUILD_TIME override.
# Outside a git checkout (or on git failure) SHA/DESCRIBE are empty; exit 0.
sha="${MARCH_GIT_SHA:-}"
describe="${MARCH_GIT_DESCRIBE:-}"
built="${MARCH_BUILD_TIME:-}"
[ -n "$sha" ] || sha=$(git rev-parse HEAD 2>/dev/null) || sha=""
[ -n "$describe" ] || describe=$(git describe --tags --long --dirty --always 2>/dev/null) || describe=""
[ -n "$built" ] || built=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null) || built=""
# Values are emitted unquoted: strip whitespace defensively.
sha=$(printf '%s' "$sha" | tr -d '[:space:]')
describe=$(printf '%s' "$describe" | tr -d '[:space:]')
built=$(printf '%s' "$built" | tr -d '[:space:]')
printf '%s\n' "--build-arg MARCH_GIT_SHA=$sha --build-arg MARCH_GIT_DESCRIBE=$describe --build-arg MARCH_BUILD_TIME=$built"
exit 0
