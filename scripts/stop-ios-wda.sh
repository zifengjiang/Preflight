#!/usr/bin/env bash
set -euo pipefail

stop_all_by_name() {
  local process_name="$1"
  local -a pids=()
  local -a remaining=()

  # macOS built-in bash (3.2) has no mapfile; collect pids via read loop.
  while IFS= read -r pid; do
    if [[ -n "${pid}" ]]; then
      pids+=("${pid}")
    fi
  done < <(pgrep -x "${process_name}" || true)

  if [[ "${#pids[@]}" -eq 0 ]]; then
    echo "[stop-ios-wda] no ${process_name} process found"
    return 0
  fi

  echo "[stop-ios-wda] stopping ${process_name} pids: ${pids[*]}"
  kill "${pids[@]}" 2>/dev/null || true
  sleep 1

  for pid in "${pids[@]}"; do
    if kill -0 "${pid}" >/dev/null 2>&1; then
      remaining+=("${pid}")
    fi
  done

  if [[ "${#remaining[@]}" -gt 0 ]]; then
    echo "[stop-ios-wda] force killing ${process_name} pids: ${remaining[*]}"
    kill -9 "${remaining[@]}" 2>/dev/null || true
  fi

  echo "[stop-ios-wda] ${process_name} cleaned"
}

echo "[stop-ios-wda] cleanup started"
stop_all_by_name "iproxy"
stop_all_by_name "xcodebuild"
# Clean up simulator WDA Node.js TCP forwarding (pattern: connect(8100, '127.0.0.1'))
pkill -f "node.*connect.8100.*127.0.0.1" 2>/dev/null || true
echo "[stop-ios-wda] cleanup finished"
