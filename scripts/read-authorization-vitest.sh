#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch14d-read-db}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch14d-read-authorization.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54425/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
DATABASE_NAME="pluginmax_batch14d_read_vitest_$STAMP"
DATABASE_URL="${DATABASE_URL_INPUT%/*}/$DATABASE_NAME"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
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
}
trap cleanup EXIT

compose up -d postgres >/dev/null
for _ in {1..80}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done
psql_database postgres "CREATE DATABASE $DATABASE_NAME;"

export DATABASE_URL="$DATABASE_URL"
export TEST_DATABASE_URL="$DATABASE_URL"
export DSH_HOME="$ROOT/.tmp/batch14d-read-vitest/dsh-home"
export FILE_STORE_ROOT="$ROOT/.tmp/batch14d-read-vitest/files"

node_modules/.bin/vitest run \
  packages/database/src/authorization-repository.test.ts \
  packages/application/src/authorization.test.ts \
  apps/api/src/authorization.test.ts \
  apps/api/src/read-authorization.test.ts
