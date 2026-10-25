#!/usr/bin/env bash
set -euo pipefail
export LC_ALL="en_US.UTF-8"
export LANG="en_US.UTF-8"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
BACKUP_ROOT="${PLUGINMAX_BACKUP_ROOT:-$ROOT/.tmp/backups}"
STAMP="$(date +%Y%m%d-%H%M%S)"
RETENTION_DAYS="${PLUGINMAX_BACKUP_RETENTION_DAYS:-7}"

mkdir -p "$BACKUP_ROOT"
chmod 700 "$BACKUP_ROOT"

tar -czf "$BACKUP_ROOT/source-$STAMP.tar.gz" \
  --exclude='node_modules' \
  --exclude='.tmp' \
  --exclude='.git' \
  --exclude='dist' \
  --exclude='lib' \
  -C "$ROOT" .

docker-compose_exec() {
  if docker compose version >/dev/null 2>&1; then
    docker compose "$@"
  else
    docker-compose "$@"
  fi
}

docker-compose_exec exec -T postgres \
  pg_dump -U pluginmax -d pluginmax --format=custom \
  > "$BACKUP_ROOT/postgres-$STAMP.dump"

shasum -a 256 \
  "$BACKUP_ROOT/source-$STAMP.tar.gz" \
  "$BACKUP_ROOT/postgres-$STAMP.dump" \
  > "$BACKUP_ROOT/SHA256SUMS-$STAMP.txt"

find "$BACKUP_ROOT" -type f -mtime "+$RETENTION_DAYS" -delete

printf 'backup_root=%s\n' "$BACKUP_ROOT"
printf 'timestamp=%s\n' "$STAMP"
printf 'source=%s\n' "$BACKUP_ROOT/source-$STAMP.tar.gz"
printf 'postgres=%s\n' "$BACKUP_ROOT/postgres-$STAMP.dump"
