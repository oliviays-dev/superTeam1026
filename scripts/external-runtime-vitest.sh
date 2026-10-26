#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch13}"
COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch13.yml}"
DATABASE_URL_INPUT="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54422/pluginmax}"
STAMP="$(date -u +%Y%m%d%H%M%S)"

compose() {
  "$ROOT/scripts/db-compose.sh" -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

psql_database() {
  local database="$1"
  local sql="$2"
  compose exec -T postgres psql -U pluginmax -d "$database" \
    -qAt -v ON_ERROR_STOP=1 -c "$sql"
}

compose up -d postgres >/dev/null
for _ in {1..60}; do
  if compose exec -T postgres pg_isready \
    -U pluginmax -d pluginmax >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

database="pluginmax_batch13_vitest_$STAMP"
database_url="${DATABASE_URL_INPUT%/*}/$database"
psql_database postgres "CREATE DATABASE $database;"

cleanup() {
  psql_database postgres \
    "DROP DATABASE IF EXISTS $database WITH (FORCE);" \
    >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$ROOT"
TEST_DATABASE_URL="$database_url" CI=true \
  pnpm vitest run \
    apps/api/src/app.test.ts \
    apps/api/src/meeting-ai-participation.test.ts \
    apps/api/src/ai-direct-chat.test.ts \
    apps/api/src/external-runtimes.test.ts \
    apps/worker/src/runtime-probe-service.test.ts \
    --no-file-parallelism

printf 'external_runtime_vitest=ok\n'
printf 'database=%s\n' "$database"
