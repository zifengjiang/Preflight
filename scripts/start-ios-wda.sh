#!/usr/bin/env bash
set -euo pipefail

UDID="${1:-}"
WDA_PORT="${2:-}"

EXIT_MISSING_ARGS=1
EXIT_DEVICE_NOT_CONNECTED=2
EXIT_WDA_START_FAILED=3
EXIT_DEPENDENCY_MISSING=4

if [[ -z "${UDID}" || -z "${WDA_PORT}" ]]; then
  echo "[start-ios-wda] usage: $0 <UDID> <WDA_PORT>"
  exit "${EXIT_MISSING_ARGS}"
fi

if ! [[ "${WDA_PORT}" =~ ^[0-9]+$ ]]; then
  echo "[start-ios-wda] invalid WDA_PORT: ${WDA_PORT}"
  exit "${EXIT_MISSING_ARGS}"
fi

# Local MJPEG port: matches Agent / Midscene convention, default = WDA local port + 1000 → device:9100 (WDA video stream)
MJPEG_LOCAL_PORT=$((WDA_PORT + 1000))
if [[ "${MJPEG_LOCAL_PORT}" -gt 65535 ]]; then
  echo "[start-ios-wda] WDA_PORT+1000 exceeds max port: ${WDA_PORT} -> ${MJPEG_LOCAL_PORT}"
  exit "${EXIT_MISSING_ARGS}"
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
AGENT_HOME="${AGENT_HOME:-${HOME}/.preflight}"

WDA_ROOT="${WDA_PROJECT_ROOT:-${REPO_ROOT}/third_party/WebDriverAgent}"
WDA_PROJECT="${WDA_PROJECT_PATH:-${WDA_ROOT}/WebDriverAgent.xcodeproj}"
WDA_SCHEME="${WDA_SCHEME:-WebDriverAgentRunner}"
WDA_DERIVED_DATA="${WDA_DERIVED_DATA:-${AGENT_HOME}/state/wda-derived-data/${UDID}}"

WDA_LOG_DIR="${WDA_LOG_DIR:-${AGENT_HOME}/logs/wda}"
WDA_LOG_FILE="${WDA_LOG_DIR}/wda-${UDID}-${WDA_PORT}.log"
IPROXY_LOG_FILE="${WDA_LOG_DIR}/iproxy-${UDID}-${WDA_PORT}.log"

WDA_STATUS_URL="http://127.0.0.1:${WDA_PORT}/status"

mkdir -p "${WDA_LOG_DIR}" "${WDA_DERIVED_DATA}"

# Lock file to prevent concurrent script instances (the watchdog polls every 5s,
# but build-for-testing can take minutes). Uses PID-based stale detection.
BUILD_LOCK_DIR="${AGENT_HOME}/state/wda-locks"
mkdir -p "${BUILD_LOCK_DIR}"
BUILD_LOCK="${BUILD_LOCK_DIR}/wda-start-${UDID}-${WDA_PORT}.pid"

try_acquire_lock() {
  if [[ -f "${BUILD_LOCK}" ]]; then
    local old_pid
    old_pid=$(cat "${BUILD_LOCK}" 2>/dev/null)
    if [[ -n "${old_pid}" ]] && kill -0 "${old_pid}" 2>/dev/null; then
      echo "[start-ios-wda] another instance already running (pid=${old_pid}), skipping"
      return 1
    fi
    echo "[start-ios-wda] removing stale lock from pid=${old_pid}"
    rm -f "${BUILD_LOCK}"
  fi
  echo "$$" > "${BUILD_LOCK}"
  trap 'rm -f "${BUILD_LOCK}"' EXIT
  return 0
}

if [[ ! -d "${WDA_PROJECT}" ]]; then
  echo "[start-ios-wda] WDA project not found: ${WDA_PROJECT}"
  echo "[start-ios-wda] run: npm run clone:wda"
  exit 1
fi

for cmd in xcrun curl iproxy xcodebuild; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "[start-ios-wda] missing dependency: ${cmd}"
    if [[ "${cmd}" == "iproxy" ]]; then
      echo "[start-ios-wda] install it with: brew install libimobiledevice"
    fi
    exit "${EXIT_DEPENDENCY_MISSING}"
  fi
done

device_is_online() {
  # Check physical devices first (== Devices ==)
  xcrun xctrace list devices 2>/dev/null | awk '
    /^== Devices ==/ { in_devices=1; next }
    /^== / { in_devices=0 }
    in_devices { print }
  ' | grep -F "(${UDID})" >/dev/null 2>&1 && return 0

  # Then check booted simulators
  xcrun simctl list devices booted 2>/dev/null | grep -F "(${UDID})" >/dev/null 2>&1
}

device_is_simulator() {
  xcrun simctl list devices booted 2>/dev/null | grep -F "(${UDID})" >/dev/null 2>&1
}

wda_is_healthy() {
  curl -fsS --max-time 2 "${WDA_STATUS_URL}" >/dev/null 2>&1
}

kill_iproxy_for_udid() {
  pkill -f "iproxy.*-u[[:space:]]+${UDID}" >/dev/null 2>&1 || true
  pkill -f "iproxy.*${UDID}" >/dev/null 2>&1 || true
}

kill_xcodebuild_for_udid() {
  pkill -f "xcodebuild.*id=${UDID}" >/dev/null 2>&1 || true
}

xcodebuild_is_running_for_udid() {
  pgrep -f "xcodebuild.*id=${UDID}" >/dev/null 2>&1
}

start_iproxy() {
  if device_is_simulator; then
    echo "[start-ios-wda] simulator mode, WDA binds directly to port ${WDA_PORT} (USE_PORT) — no forwarding needed"
    return 0
  fi
  echo "[start-ios-wda] starting iproxy: 127.0.0.1:${WDA_PORT}->device:8100, 127.0.0.1:${MJPEG_LOCAL_PORT}->device:9100 (MJPEG)"
  nohup iproxy -u "${UDID}" "${WDA_PORT}:8100" "${MJPEG_LOCAL_PORT}:9100" >>"${IPROXY_LOG_FILE}" 2>&1 &
}

# Modify .xctestrun plist to inject environment variables into the test process.
# This is the only reliable way to set env vars (USE_PORT, MJPEG_SERVER_PORT)
# for simulator test runners, because testmanagerd does NOT forward macOS env vars
# into the simulator's iOS runtime.
# Find the test-bundle key (top-level key excluding __xctestrun_metadata__) in xctestrun.
# Recent Xcode uses flat <bundleName> as key instead of TestConfigurations array.
get_xctestrun_bundle_key() {
  local xctestrun="$1"
  plutil -p "${xctestrun}" 2>/dev/null | grep '^  "' | grep -v '__xctestrun_metadata__' | head -1 | sed 's/^  "\(.*\)" =>.*/\1/'
}

inject_env_vars_into_xctestrun() {
  local xctestrun="$1"
  local port="$2"
  local mjpeg_port="$3"
  local bundle_key

  bundle_key=$(get_xctestrun_bundle_key "${xctestrun}")
  if [[ -z "${bundle_key}" ]]; then
    echo "[start-ios-wda] could not determine bundle key in xctestrun"
    return 1
  fi
  echo "[start-ios-wda] xctestrun bundle key: ${bundle_key}"

  # Method 1: Inject USE_PORT / MJPEG_SERVER_PORT into EnvironmentVariables dict
  # This is consumed by FBConfiguration's NSProcessInfo.processInfo.environment check.
  local env_path="${bundle_key}.EnvironmentVariables.USE_PORT"
  echo "[start-ios-wda] injecting USE_PORT=${port} at ${env_path}"
  if plutil -insert "${env_path}" -string "${port}" "${xctestrun}" 2>/dev/null; then
    echo "[start-ios-wda] injected USE_PORT"
  else
    # Key may already exist — replace instead
    plutil -replace "${env_path}" -string "${port}" "${xctestrun}" 2>/dev/null && \
      echo "[start-ios-wda] replaced USE_PORT" || \
      echo "[start-ios-wda] WARNING: could not set USE_PORT"
  fi

  plutil -insert "${bundle_key}.EnvironmentVariables.MJPEG_SERVER_PORT" \
    -string "${mjpeg_port}" "${xctestrun}" 2>/dev/null || \
  plutil -replace "${bundle_key}.EnvironmentVariables.MJPEG_SERVER_PORT" \
    -string "${mjpeg_port}" "${xctestrun}" 2>/dev/null || true

  # Method 2: Inject --port into CommandLineArguments (HIGHEST priority in FBConfiguration:
  # bindingPortRangeFromArguments reads NSProcessInfo.processInfo.arguments for "--port").
  local cla_path="${bundle_key}.CommandLineArguments"
  echo "[start-ios-wda] injecting --port ${port} into CommandLineArguments"
  if plutil -replace "${cla_path}" \
    -json "[\"--port\",\"${port}\",\"--mjpeg-server-port\",\"${mjpeg_port}\"]" \
    "${xctestrun}" 2>/dev/null; then
    echo "[start-ios-wda] injected --port via CommandLineArguments"
  else
    echo "[start-ios-wda] WARNING: could not set CommandLineArguments"
  fi
}

start_xcodebuild() {
  echo "[start-ios-wda] starting xcodebuild for WDA"

  if device_is_simulator; then
    echo "[start-ios-wda] simulator mode: using build-for-testing + xctestrun approach"
    echo "[start-ios-wda] (macOS env vars do NOT propagate into simulator test processes)"

    # Step 1: Build the test bundle and generate .xctestrun (blocking)
    xcodebuild build-for-testing \
      -project "${WDA_PROJECT}" \
      -scheme "${WDA_SCHEME}" \
      -destination "id=${UDID}" \
      -derivedDataPath "${WDA_DERIVED_DATA}" \
      >>"${WDA_LOG_FILE}" 2>&1

    BUILD_RESULT=$?
    if [[ "${BUILD_RESULT}" -ne 0 ]]; then
      echo "[start-ios-wda] build-for-testing failed (exit=${BUILD_RESULT})"
      echo "[start-ios-wda] check the log for details: ${WDA_LOG_FILE}"
      return 1
    fi

    # Step 2: Find the .xctestrun file in derived data
    XCTESTRUN=$(find "${WDA_DERIVED_DATA}" -name "*.xctestrun" -print -quit 2>/dev/null)
    if [[ -z "${XCTESTRUN}" ]]; then
      echo "[start-ios-wda] .xctestrun not found in ${WDA_DERIVED_DATA}"
      echo "[start-ios-wda] falling back to env-var approach (may not work)"
      USE_PORT="${WDA_PORT}" MJPEG_SERVER_PORT="${MJPEG_LOCAL_PORT}" \
      nohup xcodebuild \
        -project "${WDA_PROJECT}" \
        -scheme "${WDA_SCHEME}" \
        -destination "id=${UDID}" \
        test >>"${WDA_LOG_FILE}" 2>&1 &
    else
      # Step 3: Inject environment variables into the xctestrun plist
      inject_env_vars_into_xctestrun "${XCTESTRUN}" "${WDA_PORT}" "${MJPEG_LOCAL_PORT}"

      echo "[start-ios-wda] modified xctestrun: ${XCTESTRUN}"

      # Step 4: Run with modified xctestrun (skip rebuild, background)
      nohup xcodebuild test-without-building \
        -xctestrun "${XCTESTRUN}" \
        -destination "id=${UDID}" \
        -derivedDataPath "${WDA_DERIVED_DATA}" \
        >>"${WDA_LOG_FILE}" 2>&1 &
    fi
  else
    echo "[start-ios-wda] real-device mode: iproxy handles port forwarding, starting xcodebuild"
    nohup xcodebuild \
      -project "${WDA_PROJECT}" \
      -scheme "${WDA_SCHEME}" \
      -destination "id=${UDID}" \
      test >>"${WDA_LOG_FILE}" 2>&1 &
  fi

  XCODEBUILD_PID=$!
}

wait_for_wda() {
  local timeout_seconds="${1:-90}"

  echo "[start-ios-wda] waiting for WDA status: ${WDA_STATUS_URL}"

  for _ in $(seq 1 "${timeout_seconds}"); do
    if ! device_is_online; then
      echo "[start-ios-wda] device disconnected while starting: ${UDID}"
      exit "${EXIT_DEVICE_NOT_CONNECTED}"
    fi

    if wda_is_healthy; then
      echo "[start-ios-wda] wda ready: ${WDA_STATUS_URL}"
      echo "[start-ios-wda] mjpeg_url=http://127.0.0.1:${MJPEG_LOCAL_PORT}/ (local -> device:9100)"
      echo "[start-ios-wda] wda_log=${WDA_LOG_FILE}"
      echo "[start-ios-wda] iproxy_log=${IPROXY_LOG_FILE}"
      return 0
    fi

    sleep 1
  done

  return 1
}

echo "[start-ios-wda] checking device online: ${UDID}"

if ! device_is_online; then
  echo "[start-ios-wda] device not connected or not online: ${UDID}"
  echo "[start-ios-wda] only devices under '== Devices ==' are considered online"
  exit "${EXIT_DEVICE_NOT_CONNECTED}"
fi

# Acquire exclusive lock to prevent concurrent watchdog instances from racing.
if ! try_acquire_lock; then
  exit 0
fi

# Case 1: requested local port is already healthy.
if wda_is_healthy; then
  echo "[start-ios-wda] wda already healthy on requested port: ${WDA_STATUS_URL}"
  exit 0
fi

# Case 2: status is unhealthy. Check whether xcodebuild is already running.
if xcodebuild_is_running_for_udid; then
  echo "[start-ios-wda] xcodebuild already running for udid=${UDID}, waiting for WDA on port ${WDA_PORT}"

  if wait_for_wda 60; then
    echo "[start-ios-wda] WDA became healthy on port ${WDA_PORT}"
    exit 0
  fi

  # xcodebuild is running but WDA not healthy after waiting.
  # Could be still building, or WDA is on a different port.
  # Don't kill xcodebuild — let the next poll cycle retry.
  echo "[start-ios-wda] xcodebuild running but WDA not healthy on ${WDA_PORT} after 60s, will retry"
  exit 1
fi

# Case 3: no running xcodebuild — start fresh.
echo "[start-ios-wda] no existing xcodebuild for udid, starting xcodebuild"
if ! start_xcodebuild; then
  echo "[start-ios-wda] start_xcodebuild failed, aborting"
  echo "[start-ios-wda] check the log: ${WDA_LOG_FILE}"
  tail -n 40 "${WDA_LOG_FILE}" 2>/dev/null || true
  exit "${EXIT_WDA_START_FAILED}"
fi
start_iproxy

if wait_for_wda 90; then
  echo "[start-ios-wda] started udid=${UDID} wda_local=${WDA_PORT} mjpeg_local=${MJPEG_LOCAL_PORT}"
  if [[ -n "${XCODEBUILD_PID:-}" ]]; then
    echo "[start-ios-wda] xcodebuild_pid=${XCODEBUILD_PID}"
  fi
  exit 0
fi

echo "[start-ios-wda] failed to start WDA within timeout"
echo "[start-ios-wda] status_url=${WDA_STATUS_URL}"
echo "[start-ios-wda] wda_log=${WDA_LOG_FILE}"
echo "[start-ios-wda] iproxy_log=${IPROXY_LOG_FILE}"

echo "[start-ios-wda] last WDA logs:"
tail -n 80 "${WDA_LOG_FILE}" 2>/dev/null || true

echo "[start-ios-wda] last iproxy logs:"
tail -n 40 "${IPROXY_LOG_FILE}" 2>/dev/null || true

exit "${EXIT_WDA_START_FAILED}"
