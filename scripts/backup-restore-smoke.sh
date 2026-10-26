#!/usr/bin/env bash
set -euo pipefail
export LC_ALL="en_US.UTF-8"
export LANG="en_US.UTF-8"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${PLUGINMAX_BACKUP_ROOT:-$ROOT/.tmp/backups}"
BACKUP_SET="${1:-}"
COMPOSE_PROJECT="${PLUGINMAX_BACKUP_COMPOSE_PROJECT:-pluginmax-batch9}"
COMPOSE_FILE="${PLUGINMAX_BACKUP_COMPOSE_FILE:-docker-compose.batch9.yml}"
EXPECTED_VERSION="${PLUGINMAX_EXPECTED_MIGRATION_VERSION:-14}"
DATABASE_URL_VALUE="${PLUGINMAX_RESTORE_DATABASE_URL:-${DATABASE_URL:-}}"
RESTORE_MODE="${PLUGINMAX_RESTORE_DATABASE_MODE:-}"
STAMP="$(date -u +%Y%m%d%H%M%S)"
TEMP_DATABASE="pluginmax_restore_verify_${STAMP}_$$"

if [[ -z "$BACKUP_SET" ]]; then
  BACKUP_SET="$(
    find "$BACKUP_ROOT/sets" -mindepth 1 -maxdepth 1 -type d -name '20*' 2>/dev/null |
      sort -r |
      awk 'NR == 1'
  )"
fi
if [[ -z "$BACKUP_SET" || ! -d "$BACKUP_SET" ]]; then
  printf 'backup set not found: %s\n' "$BACKUP_SET" >&2
  exit 2
fi
if [[ ! "$TEMP_DATABASE" =~ ^pluginmax_restore_verify_[0-9]+_[0-9]+$ ]]; then
  printf 'refusing unsafe temporary database name\n' >&2
  exit 2
fi
if [[ ! "$EXPECTED_VERSION" =~ ^[0-9]+$ ]]; then
  printf 'PLUGINMAX_EXPECTED_MIGRATION_VERSION must be an integer\n' >&2
  exit 2
fi

source_archive="$BACKUP_SET/source.tar.gz"
database_archive="$BACKUP_SET/postgres.dump"
manifest="$BACKUP_SET/manifest.json"
checksums="$BACKUP_SET/SHA256SUMS"

for file in "$source_archive" "$database_archive" "$manifest" "$checksums"; do
  if [[ ! -s "$file" ]]; then
    printf 'backup artifact is missing or empty: %s\n' "$(basename "$file")" >&2
    exit 2
  fi
done

(
  cd "$BACKUP_SET"
  shasum -a 256 -c SHA256SUMS >/dev/null
)

if [[ "$(jq -r '.format' "$manifest")" != "pluginmax-backup-v1" ]]; then
  printf 'unsupported backup manifest format\n' >&2
  exit 2
fi
if jq -e '.database.migrationVersion < 14' "$manifest" >/dev/null; then
  printf 'backup predates migration 14 trace schema\n' >&2
  exit 2
fi

source_listing="$(tar -tzf "$source_archive")"
for expected in './package.json' './pnpm-lock.yaml' './apps/api/src/app.ts'; do
  if ! grep -Fxq "$expected" <<< "$source_listing"; then
    printf 'source archive is missing %s\n' "$expected" >&2
    exit 2
  fi
done
for forbidden in './.env' './.git/' './node_modules/' './.aws/' './.ssh/'; do
  if grep -Fq "$forbidden" <<< "$source_listing"; then
    printf 'source archive contains forbidden path %s\n' "$forbidden" >&2
    exit 2
  fi
done

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

if [[ -z "$RESTORE_MODE" ]]; then
  RESTORE_MODE="$(jq -r '.database.mode' "$manifest")"
fi
case "$RESTORE_MODE" in
  local|docker) ;;
  *)
    printf 'restore mode must be local or docker\n' >&2
    exit 2
    ;;
esac

if [[ "$RESTORE_MODE" == "local" ]]; then
  if [[ -z "$DATABASE_URL_VALUE" ]]; then
    printf 'local restore requires PLUGINMAX_RESTORE_DATABASE_URL or DATABASE_URL\n' >&2
    exit 2
  fi
  if ! command -v pg_restore >/dev/null 2>&1 ||
    ! command -v psql >/dev/null 2>&1; then
    printf 'local restore requires pg_restore and psql on PATH\n' >&2
    exit 2
  fi
  TEMP_DATABASE_URL="$(
    BACKUP_DATABASE_URL="$DATABASE_URL_VALUE" TEMP_DATABASE="$TEMP_DATABASE" \
      node -e '
        const url = new URL(process.env.BACKUP_DATABASE_URL);
        url.pathname = `/${process.env.TEMP_DATABASE}`;
        process.stdout.write(url.toString());
      '
  )"
  cleanup_database() {
    PGDATABASE="$DATABASE_URL_VALUE" psql -qAt -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$TEMP_DATABASE\" WITH (FORCE)" \
      >/dev/null 2>&1 || true
  }
  trap cleanup_database EXIT
  PGDATABASE="$DATABASE_URL_VALUE" psql -qAt -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$TEMP_DATABASE\"" >/dev/null
  PGDATABASE="$TEMP_DATABASE_URL" pg_restore \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    "$database_archive"
  run_query() {
    PGDATABASE="$TEMP_DATABASE_URL" psql -qAt -v ON_ERROR_STOP=1 -c "$1"
  }
else
  if [[ ! -f "$ROOT/$COMPOSE_FILE" ]]; then
    printf 'compose file not found: %s\n' "$COMPOSE_FILE" >&2
    exit 2
  fi
  compose up -d postgres >/dev/null
  for _ in {1..60}; do
    if compose exec -T postgres pg_isready \
      -U pluginmax -d pluginmax >/dev/null 2>&1; then
      break
    fi
    sleep 1
  done
  cleanup_database() {
    compose exec -T postgres psql -U pluginmax -d postgres -qAt \
      -v ON_ERROR_STOP=1 \
      -c "DROP DATABASE IF EXISTS \"$TEMP_DATABASE\" WITH (FORCE)" \
      >/dev/null 2>&1 || true
  }
  trap cleanup_database EXIT
  compose exec -T postgres psql -U pluginmax -d postgres -qAt \
    -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"$TEMP_DATABASE\"" >/dev/null
  compose exec -T postgres pg_restore \
    -U pluginmax \
    -d "$TEMP_DATABASE" \
    --no-owner \
    --no-privileges \
    --exit-on-error \
    < "$database_archive"
  run_query() {
    compose exec -T postgres psql -U pluginmax -d "$TEMP_DATABASE" \
      -qAt -v ON_ERROR_STOP=1 -c "$1"
  }
fi

migration_version="$(run_query \
  'SELECT COALESCE(MAX(version), 0) FROM platform_migrations;')"
core_tables="$(run_query "
  SELECT COUNT(*)
  FROM information_schema.tables
  WHERE table_schema = 'public'
    AND table_name IN ('platform_migrations', 'runs', 'run_events', 'jobs');
")"
trace_columns="$(run_query "
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND table_name = 'run_events'
    AND column_name IN ('trace_id', 'span_id', 'parent_span_id');
")"
trace_links="$(run_query "
  SELECT
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'jobs' AND column_name = 'trace_id') ||
    ':' ||
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'runtime_effect_receipts'
       AND column_name = 'trace_id') ||
    ':' ||
    (SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'runtime_maintenance_runs'
       AND column_name = 'trace_id');
")"

if [[ "$migration_version" -lt "$EXPECTED_VERSION" ||
      "$core_tables" != "4" ||
      "$trace_columns" != "3" ||
      "$trace_links" != "1:1:1" ]]; then
  printf 'restore verification failed: migration=%s core_tables=%s trace_columns=%s trace_links=%s\n' \
    "$migration_version" "$core_tables" "$trace_columns" "$trace_links" >&2
  exit 1
fi

printf 'restore_smoke=ok\n'
printf 'backup_set=%s\n' "$BACKUP_SET"
printf 'restore_mode=%s\n' "$RESTORE_MODE"
printf 'migration_version=%s\n' "$migration_version"
printf 'core_tables=%s\n' "$core_tables"
printf 'trace_columns=%s\n' "$trace_columns"
printf 'trace_links=%s\n' "$trace_links"
