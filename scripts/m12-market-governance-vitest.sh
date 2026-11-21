#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${M12_GOVERNANCE_COMPOSE_PROJECT:-pluginmax-m12-governance}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.core-regression.yml}"
PORT="${M12_GOVERNANCE_POSTGRES_PORT:-54467}"
export CORE_REGRESSION_POSTGRES_PORT="$PORT"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:${PORT}/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_m12_governance_${STAMP}"
TEST_DATABASE_URL="${DATABASE_URL_INPUT%/*}/${DATABASE_NAME}"

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" \
    -f "$ROOT/$COMPOSE_FILE" \
    "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $DATABASE_NAME WITH (FORCE);" \
    >/dev/null 2>&1 || true
  if [[ "${M12_GOVERNANCE_KEEP_ENV:-0}" != "1" ]]; then
    compose down -v >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..120}; do
  container_id="$(compose ps -q postgres)"
  health="$(
    docker inspect --format '{{.State.Health.Status}}' \
      "$container_id" 2>/dev/null || true
  )"
  if [[ "$health" == "healthy" ]] &&
    psql_database postgres "SELECT 1;" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

psql_database postgres "CREATE DATABASE $DATABASE_NAME;"
DATABASE_URL="$TEST_DATABASE_URL" \
  node_modules/.bin/tsx packages/database/src/migrate-cli.ts >/dev/null

if [[ "$#" -gt 0 ]]; then
  TEST_DATABASE_URL="$TEST_DATABASE_URL" CI=true pnpm vitest run "$@"
else
  TEST_DATABASE_URL="$TEST_DATABASE_URL" CI=true \
    pnpm vitest run apps/api/src/market-governance.test.ts
fi
