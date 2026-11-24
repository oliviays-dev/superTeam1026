#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-4310}"
WEB_PORT="${WEB_PORT:-4311}"
API_PID=""
WORKER_PID=""

if [ -x "$HOME/.local/node-v24.9.0/bin/node" ]; then
  export PATH="$HOME/.local/node-v24.9.0/bin:$PATH"
fi

cleanup() {
  for pid in "$WORKER_PID" "$API_PID"; do
    if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT INT TERM

cd "$ROOT"
printf 'remote_preview_node=%s pnpm=%s\n' "$(node --version)" "$(pnpm --version)"

if ! docker info >/dev/null 2>&1; then
  printf 'docker access is required for PostgreSQL; add codex to the docker group\n' >&2
  exit 1
fi

pnpm db:up
pnpm db:migrate
pnpm build:packages
pnpm --filter @pluginmax/api build
pnpm --filter @pluginmax/worker build
./scripts/safe-web-check.sh

API_HOST=127.0.0.1 API_PORT="$API_PORT" node apps/api/lib/index.js &
API_PID=$!

for _ in {1..60}; do
  if curl -fsS --max-time 2 "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done
curl -fsS --max-time 3 "http://127.0.0.1:$API_PORT/api/v1/health" >/dev/null

API_PORT="$API_PORT" node apps/worker/lib/index.js &
WORKER_PID=$!

printf 'remote_preview_api=http://127.0.0.1:%s\n' "$API_PORT"
printf 'remote_preview_web=http://127.0.0.1:%s\n' "$WEB_PORT"
printf 'remote_preview=ready\n'

API_PORT="$API_PORT" WEB_PORT="$WEB_PORT" \
  pnpm --filter @pluginmax/web exec vite preview \
  --host 127.0.0.1 --port "$WEB_PORT"
