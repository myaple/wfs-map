#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
# Each invocation owns its own disposable database and network.
export COMPOSE_PROJECT_NAME="wfs-e2e-${GITHUB_RUN_ID:-$$}"
compose=(docker compose -f deploy/compose.e2e.yml --profile tests)
cleanup() {
  code=$?
  if test "$code" != 0; then "${compose[@]}" logs --no-color api frontend database fixture || true; fi
  "${compose[@]}" down --volumes --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT
if test -z "${WFS_TEST_IMAGE:-}"; then "${compose[@]}" build api; fi
"${compose[@]}" build frontend fixture tests
"${compose[@]}" up -d --no-build --wait database api frontend fixture
"${compose[@]}" run --rm --no-deps tests
