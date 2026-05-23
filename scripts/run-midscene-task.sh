#!/usr/bin/env bash
# Midscene subprocess entry: prefer Node/tsx from runtime package; fall back to nvm + npx in dev mode.
set -euo pipefail

TASK_SCRIPT="${1:?usage: run-midscene-task.sh <path-to-task-script.ts>}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/nvm-use-repo.sh"

cd "${REPO_ROOT}"

NODE_BIN="${PREFLIGHT_RUNTIME_NODE:-}"
if [[ -z "${NODE_BIN}" && -x "${REPO_ROOT}/node/bin/node" ]]; then
  NODE_BIN="${REPO_ROOT}/node/bin/node"
fi
if [[ -z "${NODE_BIN}" ]]; then
  _nvm_use_repo "${REPO_ROOT}" || true
  NODE_BIN="$(command -v node || true)"
fi
if [[ -z "${NODE_BIN}" || ! -x "${NODE_BIN}" ]]; then
  echo "[run-midscene-task] Node not found. Install Node 20+ or use the runtime package's node/bin/node." >&2
  exit 1
fi

if [[ -d "${REPO_ROOT}/node/bin" ]]; then
  export PATH="${REPO_ROOT}/node/bin:${PATH}"
fi

major="$("${NODE_BIN}" -p "parseInt(process.versions.node,10)" 2>/dev/null || echo 0)"
if [[ "${major}" -lt 20 ]]; then
  echo "[run-midscene-task] Node >= 20 required (current: $("${NODE_BIN}" -v 2>/dev/null || echo unknown))." >&2
  echo "[run-midscene-task] Install Node 20+ or set PREFLIGHT_RUNTIME_NODE or MIDSCENE_RUN_COMMAND to override." >&2
  exit 1
fi

TSX_CLI="${REPO_ROOT}/node_modules/tsx/dist/cli.mjs"
if [[ -f "${TSX_CLI}" ]]; then
  exec "${NODE_BIN}" "${TSX_CLI}" "${TASK_SCRIPT}"
fi

exec npx tsx "${TASK_SCRIPT}"
