# Shared helpers for the measurement scripts. Source this file; do not run it.
# Needs bash (the `time` keyword) and Node 24 on PATH (source ~/.nvm/nvm.sh; nvm use 24).

# repo root of the checkout being measured: REPO env var, else the current git toplevel
repo_root() { git -C "${REPO:-.}" rev-parse --show-toplevel; }

# timed <csv> <key-columns> <log> -- <command...>
# Runs the command in $PWD, appends "<key-columns>,<wall_s>,<user_s>,<sys_s>,<exit>" to <csv>.
# wall = elapsed seconds; user and sys = CPU seconds of the command and every descendant it
# waited for (bash `time`), which is the "machine time" of the run.
timed() {
  local csv=$1 keys=$2 log=$3 rc t
  shift 4
  TIMEFORMAT='%3R,%3U,%3S'
  { time "$@" >"$log" 2>&1; rc=$?; } 2>/tmp/.timed.$$ || true
  t=$(tail -n 1 /tmp/.timed.$$)
  rm -f /tmp/.timed.$$
  [ -f "$csv" ] || echo "${CSV_HEADER:-keys},wall_s,user_s,sys_s,exit" >"$csv"
  echo "$keys,$t,$rc" >>"$csv"
  return 0
}

# host facts, no hostnames or user names
host_facts() {
  echo "cpus=$(nproc)"
  echo "mem_gb=$(awk '/MemTotal/ {printf "%.0f", $2/1048576}' /proc/meminfo)"
  echo "cpu_model=$(awk -F: '/model name/ {print $2; exit}' /proc/cpuinfo | sed 's/^ //')"
  echo "node=$(node -v)"
  echo "pnpm=$(pnpm -v)"
  echo "git=$(git --version | awk '{print $3}')"
  echo "kernel=$(uname -r)"
}
