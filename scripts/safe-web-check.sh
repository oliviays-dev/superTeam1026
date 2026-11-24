#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LOG_DIR="${SAFE_WEB_LOG_DIR:-$ROOT/.tmp/safe-web-check}"
LOCK_DIR="$ROOT/.tmp/safe-web-check.lock"
LOG_FILE="$LOG_DIR/web-check.log"
MIN_AVAILABLE_MIB="${SAFE_WEB_MIN_AVAILABLE_MIB:-512}"
TIMEOUT_SECONDS="${SAFE_WEB_TIMEOUT_SECONDS:-300}"

if [ -x "$HOME/.local/node-v24.9.0/bin/node" ]; then
  export PATH="$HOME/.local/node-v24.9.0/bin:$PATH"
fi

mkdir -p "$LOG_DIR"

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  printf 'safe-web-check is already running; refusing concurrent work\n' >&2
  exit 75
fi

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

printf 'node=%s pnpm=%s\n' "$(node --version)" "$(pnpm --version)"

workload() {
  cd "$ROOT"
  pnpm --filter @pluginmax/web typecheck
  pnpm --filter @pluginmax/web build
}

if [ "$(uname -s)" = "Linux" ] &&
  [ -r /proc/meminfo ] &&
  command -v setsid >/dev/null 2>&1; then
  total_kb="$(awk '/MemTotal/ {print $2}' /proc/meminfo)"
  min_available_kb="$total_kb"
  peak_used_kb=0
  aborted_reason=""
  started_at="$SECONDS"

  setsid bash -c "$(declare -f workload); ROOT=$(printf '%q' "$ROOT"); workload" \
    >"$LOG_FILE" 2>&1 &
  workload_pid=$!

  while kill -0 "$workload_pid" 2>/dev/null; do
    available_kb="$(awk '/MemAvailable/ {print $2}' /proc/meminfo)"
    used_kb=$((total_kb - available_kb))
    if [ "$available_kb" -lt "$min_available_kb" ]; then
      min_available_kb="$available_kb"
    fi
    if [ "$used_kb" -gt "$peak_used_kb" ]; then
      peak_used_kb="$used_kb"
    fi

    if [ "$available_kb" -lt $((MIN_AVAILABLE_MIB * 1024)) ]; then
      aborted_reason="low_memory"
      break
    fi
    if [ $((SECONDS - started_at)) -ge "$TIMEOUT_SECONDS" ]; then
      aborted_reason="timeout"
      break
    fi
    sleep 0.25
  done

  if [ -n "$aborted_reason" ]; then
    kill -TERM -- "-$workload_pid" 2>/dev/null || true
    sleep 2
    kill -KILL -- "-$workload_pid" 2>/dev/null || true
  fi

  set +e
  wait "$workload_pid"
  status=$?
  set -e

  if [ -n "$aborted_reason" ]; then
    status=124
  fi

  printf 'safe_web_result status=%s reason=%s peak_used_mib=%s min_available_mib=%s threshold_mib=%s\n' \
    "$status" \
    "${aborted_reason:-none}" \
    "$((peak_used_kb / 1024))" \
    "$((min_available_kb / 1024))" \
    "$MIN_AVAILABLE_MIB"
else
  set +e
  workload >"$LOG_FILE" 2>&1
  status=$?
  set -e
  printf 'safe_web_result status=%s reason=unmonitored peak_used_mib=unknown min_available_mib=unknown threshold_mib=%s\n' \
    "$status" "$MIN_AVAILABLE_MIB"
fi

printf '\nweb_check_log_tail\n'
tail -n 60 "$LOG_FILE"

if [ "$status" -ne 0 ]; then
  exit "$status"
fi

if command -v curl >/dev/null 2>&1; then
  if curl -fsS --max-time 3 http://127.0.0.1:4310/api/v1/health >/dev/null 2>&1; then
    printf 'preview_health=ok\n'
  else
    printf 'preview_health=unavailable\n'
  fi
fi

printf 'safe_web_check=ok\n'
