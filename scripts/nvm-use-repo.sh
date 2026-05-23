# shellcheck shell=bash
# Sourced by run-midscene-task.sh: load nvm and run `nvm use` in the repo root.
# No side effects: failure does not exit; caller decides whether to error on insufficient Node version.

_try_source_nvm() {
  if [[ -n "${NVM_DIR:-}" && -s "${NVM_DIR}/nvm.sh" ]]; then
    # shellcheck disable=SC1090
    source "${NVM_DIR}/nvm.sh"
    return 0
  fi
  local d
  for d in "${HOME}/.nvm" "/usr/local/opt/nvm"; do
    if [[ -s "${d}/nvm.sh" ]]; then
      export NVM_DIR="${d}"
      # shellcheck disable=SC1090
      source "${d}/nvm.sh"
      return 0
    fi
  done
  return 1
}

_nvm_use_repo() {
  local repo_root="${1:?repo root}"
  _try_source_nvm || return 1
  local dsave="${PWD}"
  cd "${repo_root}" || return 1
  nvm use >/dev/null 2>&1 || true
  cd "${dsave}" || true
  return 0
}
