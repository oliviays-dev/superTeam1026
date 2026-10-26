#!/usr/bin/env bash
set -Eeuo pipefail
export LC_ALL="en_US.UTF-8"
export LANG="en_US.UTF-8"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${PLUGINMAX_BACKUP_ROOT:-$ROOT/.tmp/backups}"
RETENTION_DAYS="${PLUGINMAX_BACKUP_RETENTION_DAYS:-14}"
RETENTION_COUNT="${PLUGINMAX_BACKUP_RETENTION_COUNT:-30}"
DATABASE_URL_VALUE="${PLUGINMAX_BACKUP_DATABASE_URL:-${DATABASE_URL:-}}"
COMPOSE_PROJECT="${PLUGINMAX_BACKUP_COMPOSE_PROJECT:-pluginmax-batch9}"
COMPOSE_FILE="${PLUGINMAX_BACKUP_COMPOSE_FILE:-docker-compose.batch9.yml}"
DATABASE_MODE="${PLUGINMAX_BACKUP_DATABASE_MODE:-auto}"
VERIFY="${PLUGINMAX_BACKUP_VERIFY:-1}"
ALERT_WEBHOOK="${PLUGINMAX_BACKUP_ALERT_WEBHOOK:-}"
METRICS_FILE="${PLUGINMAX_BACKUP_METRICS_FILE:-}"
LOCK_STALE_SECONDS="${PLUGINMAX_BACKUP_LOCK_STALE_SECONDS:-21600}"
STAMP="${PLUGINMAX_BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}"
SETS_ROOT="$BACKUP_ROOT/sets"
STAGING=""
LOCK_DIR="$BACKUP_ROOT/.backup.lock"
DRY_RUN=0
LOCK_ACQUIRED=0

usage() {
  cat <<'EOF'
Usage: scripts/backup.sh [--dry-run] [--no-verify]

Required environment for external PostgreSQL mode:
  PLUGINMAX_BACKUP_DATABASE_URL or DATABASE_URL

Optional:
  PLUGINMAX_BACKUP_ROOT                 default: <repo>/.tmp/backups
  PLUGINMAX_BACKUP_RETENTION_DAYS       default: 14
  PLUGINMAX_BACKUP_RETENTION_COUNT      default: 30
  PLUGINMAX_BACKUP_DATABASE_MODE        auto | local | docker
  PLUGINMAX_BACKUP_VERIFY               1 | 0
  PLUGINMAX_BACKUP_ALERT_WEBHOOK        failure notification URL
  PLUGINMAX_BACKUP_METRICS_FILE         Prometheus textfile output
  PLUGINMAX_BACKUP_COMPOSE_PROJECT      default: pluginmax-batch9
  PLUGINMAX_BACKUP_COMPOSE_FILE         default: docker-compose.batch9.yml
EOF
}

for argument in "$@"; do
  case "$argument" in
    --dry-run) DRY_RUN=1 ;;
    --no-verify) VERIFY=0 ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$argument" >&2
      usage >&2
      exit 2
      ;;
  esac
done

for value in "$RETENTION_DAYS" "$RETENTION_COUNT" "$LOCK_STALE_SECONDS"; do
  if [[ ! "$value" =~ ^[0-9]+$ ]] || [[ "$value" -lt 1 ]]; then
    printf 'retention and lock values must be positive integers\n' >&2
    exit 2
  fi
done

compose() {
  "$ROOT/scripts/db-compose.sh" \
    -p "$COMPOSE_PROJECT" -f "$ROOT/$COMPOSE_FILE" "$@"
}

resolve_database_mode() {
  case "$DATABASE_MODE" in
    local)
      printf 'local\n'
      ;;
    docker)
      printf 'docker\n'
      ;;
    auto)
      if [[ -n "$DATABASE_URL_VALUE" ]] && command -v pg_dump >/dev/null 2>&1; then
        printf 'local\n'
      else
        printf 'docker\n'
      fi
      ;;
    *)
      printf 'PLUGINMAX_BACKUP_DATABASE_MODE must be auto, local, or docker\n' >&2
      exit 2
      ;;
  esac
}

MODE="$(resolve_database_mode)"
if [[ "$MODE" == "local" && -z "$DATABASE_URL_VALUE" ]]; then
  printf 'local database mode requires PLUGINMAX_BACKUP_DATABASE_URL or DATABASE_URL\n' >&2
  exit 2
fi
if [[ "$MODE" == "local" ]] && ! command -v pg_dump >/dev/null 2>&1; then
  printf 'local database mode requires pg_dump on PATH\n' >&2
  exit 2
fi
if [[ ! -f "$ROOT/$COMPOSE_FILE" ]]; then
  printf 'compose file not found: %s\n' "$COMPOSE_FILE" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  printf 'jq is required\n' >&2
  exit 2
fi

retention_candidates() {
  [[ -d "$SETS_ROOT" ]] || return 0
  local index=0
  while IFS= read -r candidate; do
    [[ -n "$candidate" ]] || continue
    index=$((index + 1))
    if [[ "$index" -gt "$RETENTION_COUNT" ]] ||
      find "$candidate" -maxdepth 0 -type d -mtime "+$RETENTION_DAYS" -print -quit |
        grep -q .; then
      printf '%s\n' "$candidate"
    fi
  done < <(find "$SETS_ROOT" -mindepth 1 -maxdepth 1 -type d -name '20*' |
    sort -r)
}

if [[ "$DRY_RUN" == "1" ]]; then
  printf 'backup_dry_run=ok\n'
  printf 'backup_root=%s\n' "$BACKUP_ROOT"
  printf 'timestamp=%s\n' "$STAMP"
  printf 'database_mode=%s\n' "$MODE"
  printf 'source_archive=%s\n' "$SETS_ROOT/$STAMP/source.tar.gz"
  printf 'database_archive=%s\n' "$SETS_ROOT/$STAMP/postgres.dump"
  printf 'verify=%s\n' "$VERIFY"
  printf 'retention_days=%s\n' "$RETENTION_DAYS"
  printf 'retention_count=%s\n' "$RETENTION_COUNT"
  printf 'retention_candidates=%s\n' \
    "$(retention_candidates | wc -l | tr -d ' ')"
  exit 0
fi

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

write_metrics() {
  local success="$1"
  [[ -n "$METRICS_FILE" ]] || return 0
  local now
  now="$(date +%s)"
  mkdir -p "$(dirname "$METRICS_FILE")"
  {
    printf '# TYPE pluginmax_backup_last_attempt_success gauge\n'
    printf 'pluginmax_backup_last_attempt_success %s\n' "$success"
    printf '# TYPE pluginmax_backup_last_attempt_timestamp_seconds gauge\n'
    printf 'pluginmax_backup_last_attempt_timestamp_seconds %s\n' "$now"
    if [[ "$success" == "1" ]]; then
      printf '# TYPE pluginmax_backup_last_success_timestamp_seconds gauge\n'
      printf 'pluginmax_backup_last_success_timestamp_seconds %s\n' "$now"
      printf '# TYPE pluginmax_backup_last_size_bytes gauge\n'
      printf 'pluginmax_backup_last_size_bytes %s\n' "$(backup_size_bytes)"
    fi
  } > "$METRICS_FILE.tmp"
  mv "$METRICS_FILE.tmp" "$METRICS_FILE"
}

write_status() {
  local status="$1"
  local message="${2:-}"
  jq -n \
    --arg status "$status" \
    --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
    --arg message "$message" \
    --arg host "$(hostname)" \
    '{source:"pluginmax-backup",status:$status,timestamp:$timestamp,
      message:$message,host:$host}' \
    > "$BACKUP_ROOT/status.json.tmp"
  mv "$BACKUP_ROOT/status.json.tmp" "$BACKUP_ROOT/status.json"
}

alert_failure() {
  local code="$1"
  write_status "failed" "backup failed with exit code $code"
  write_metrics 0
  if [[ -n "$ALERT_WEBHOOK" ]]; then
    local payload
    payload="$(
      jq -n \
        --arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
        --arg host "$(hostname)" \
        --arg code "$code" \
        '{source:"pluginmax-backup",status:"failed",timestamp:$timestamp,
          host:$host,exitCode:($code|tonumber)}'
    )"
    if ! curl -fsS --max-time 10 \
      -H 'content-type: application/json' \
      -d "$payload" "$ALERT_WEBHOOK" >/dev/null; then
      printf 'backup alert delivery failed\n' >&2
    fi
  fi
}

backup_size_bytes() {
  [[ -n "${final_dir:-}" ]] || {
    printf '0\n'
    return
  }
  find "$final_dir" -type f -exec wc -c {} + |
    awk '{total += $1} END {printf "%d\n", total}'
}

cleanup() {
  local exit_code="$?"
  if [[ -n "$STAGING" && -d "$STAGING" ]]; then
    rm -rf "$STAGING"
  fi
  if [[ "$LOCK_ACQUIRED" == "1" && -d "$LOCK_DIR" ]]; then
    rm -rf "$LOCK_DIR"
  fi
  if [[ "$exit_code" -ne 0 ]]; then
    alert_failure "$exit_code"
  fi
}
trap cleanup EXIT

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  lock_age=0
  if [[ -d "$LOCK_DIR" ]]; then
    lock_mtime="$(stat -f %m "$LOCK_DIR" 2>/dev/null ||
      stat -c %Y "$LOCK_DIR" 2>/dev/null || printf '0')"
    lock_age=$(( $(date +%s) - lock_mtime ))
  fi
  if [[ "$lock_age" -le "$LOCK_STALE_SECONDS" ]]; then
    printf 'another backup is already running: %s\n' "$LOCK_DIR" >&2
    exit 3
  fi
  rm -rf "$LOCK_DIR"
  mkdir "$LOCK_DIR"
fi
LOCK_ACQUIRED=1
printf '%s\n' "$$" > "$LOCK_DIR/pid"

mkdir -p "$SETS_ROOT"
STAGING="$SETS_ROOT/.staging-$STAMP-$$"
mkdir -p "$STAGING"
chmod 700 "$STAGING"

source_archive="$STAGING/source.tar.gz"
database_archive="$STAGING/postgres.dump"

tar_excludes=(
  "--exclude=./node_modules"
  "--exclude=./.git"
  "--exclude=./.tmp"
  "--exclude=./lib"
  "--exclude=./dist"
  "--exclude=./coverage"
  "--exclude=./.env"
  "--exclude=./.env.*"
  "--exclude=./.aws"
  "--exclude=./.ssh"
  "--exclude=*.pem"
  "--exclude=*.key"
  "--exclude=*.p12"
)
case "$BACKUP_ROOT/" in
  "$ROOT/"*)
    backup_relative="${BACKUP_ROOT#"$ROOT/"}"
    tar_excludes+=("--exclude=./$backup_relative")
    ;;
esac
tar -czf "$source_archive" "${tar_excludes[@]}" -C "$ROOT" .

if [[ "$MODE" == "local" ]]; then
  PGDATABASE="$DATABASE_URL_VALUE" pg_dump \
    --format=custom \
    --no-owner \
    --no-privileges \
    --file="$database_archive"
else
  compose exec -T postgres pg_dump \
    -U pluginmax \
    -d pluginmax \
    --format=custom \
    --no-owner \
    --no-privileges \
    > "$database_archive"
fi

source_sha="$(shasum -a 256 "$source_archive" | awk '{print $1}')"
database_sha="$(shasum -a 256 "$database_archive" | awk '{print $1}')"
source_bytes="$(wc -c < "$source_archive" | tr -d ' ')"
database_bytes="$(wc -c < "$database_archive" | tr -d ' ')"
git_sha="$(git -C "$ROOT" rev-parse HEAD)"
git_status="$(git -C "$ROOT" status --porcelain | wc -l | tr -d ' ')"
if [[ "$MODE" == "local" ]]; then
  migration_version="$(
    PGDATABASE="$DATABASE_URL_VALUE" psql -qAt -v ON_ERROR_STOP=1 \
      -c "SELECT COALESCE(MAX(version), 0) FROM platform_migrations"
  )"
else
  migration_version="$(
    compose exec -T postgres psql -U pluginmax -d pluginmax -qAt \
      -v ON_ERROR_STOP=1 \
      -c "SELECT COALESCE(MAX(version), 0) FROM platform_migrations"
  )"
fi

jq -n \
  --arg format "pluginmax-backup-v1" \
  --arg createdAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg stamp "$STAMP" \
  --arg gitSha "$git_sha" \
  --argjson dirtyFiles "$git_status" \
  --arg databaseMode "$MODE" \
  --arg migrationVersion "$migration_version" \
  --arg sourceFile "source.tar.gz" \
  --arg sourceSha256 "$source_sha" \
  --argjson sourceBytes "$source_bytes" \
  --arg databaseFile "postgres.dump" \
  --arg databaseSha256 "$database_sha" \
  --argjson databaseBytes "$database_bytes" \
  '{format:$format,createdAt:$createdAt,stamp:$stamp,
    source:{archive:$sourceFile,sha256:$sourceSha256,bytes:$sourceBytes,
      gitSha:$gitSha,dirtyFiles:$dirtyFiles},
    database:{archive:$databaseFile,sha256:$databaseSha256,bytes:$databaseBytes,
      mode:$databaseMode,migrationVersion:($migrationVersion|tonumber)},
    secretsExcluded:[".env",".env.*",".aws",".ssh","*.pem","*.key","*.p12"]}' \
  > "$STAGING/manifest.json"

(
  cd "$STAGING"
  shasum -a 256 source.tar.gz postgres.dump manifest.json \
    > SHA256SUMS
)

final_dir="$SETS_ROOT/$STAMP"
if [[ -e "$final_dir" ]]; then
  printf 'backup set already exists: %s\n' "$final_dir" >&2
  exit 4
fi
mv "$STAGING" "$final_dir"
STAGING=""

if [[ "$VERIFY" == "1" ]]; then
  "$ROOT/scripts/backup-restore-smoke.sh" "$final_dir"
fi

while IFS= read -r candidate; do
  [[ -n "$candidate" ]] || continue
  rm -rf "$candidate"
done < <(retention_candidates)

write_status "success"
write_metrics 1

printf 'backup=ok\n'
printf 'backup_root=%s\n' "$BACKUP_ROOT"
printf 'backup_set=%s\n' "$final_dir"
printf 'manifest=%s\n' "$final_dir/manifest.json"
printf 'source_sha256=%s\n' "$source_sha"
printf 'database_sha256=%s\n' "$database_sha"
printf 'migration_version=%s\n' "$migration_version"
printf 'verified=%s\n' "$VERIFY"
