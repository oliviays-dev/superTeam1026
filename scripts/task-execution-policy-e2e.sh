#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

export COMPOSE_PROJECT="${COMPOSE_PROJECT:-pluginmax-batch15a-db}"
export COMPOSE_FILE="${COMPOSE_FILE:-docker-compose.batch15a.yml}"
export DATABASE_URL="${DATABASE_URL:-postgres://pluginmax:pluginmax@127.0.0.1:54426/pluginmax}"
export API_PORT="${API_PORT:-4486}"
export WEB_PORT="${WEB_PORT:-4442}"
export TMP_ROOT="${TMP_ROOT:-$ROOT/.tmp/batch15a-e2e}"

exec "$ROOT/scripts/rbac-authorization-e2e.sh"
