#!/bin/zsh
# Runs the M1 phone journey in ouro-rebirth-sim against a fresh local ourod on the stand-in model.
# Installs the current checkout first (scripts/ios-sim.sh). Screenshots go to .tools/maestro-out, never to the repo.
set -euo pipefail
repo=${0:A:h:h}
port=${OURO_MAESTRO_PORT:-8797}
run=$repo/runs/maestro-m1
flows=$repo/apps/mobile/maestro/m1
export JAVA_HOME=$repo/.tools/jdk MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro=$repo/.tools/maestro/bin/maestro
[[ -x $maestro && -x $JAVA_HOME/bin/java ]] || { echo "Maestro and a JDK are expected in .tools (see apps/mobile/maestro/README.md)" >&2; exit 1; }
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null; then echo "port $port is in use; set OURO_MAESTRO_PORT" >&2; exit 1; fi
simulator=${OURO_SIM:-ouro-rebirth-sim}
udid=$(xcrun simctl list devices | awk -F'[()]' -v name="$simulator" '$0 ~ "^ +"name" " {print $2; exit}')
[[ -n $udid ]] || { echo "no simulator named $simulator" >&2; exit 1; }

ourod_pid=
start_ourod() {
  OURO_DATA=$run/data OURO_APP_LISTEN=tcp:$port OURO_MACHINE_NAME=maestro OURO_DEFAULT_MODEL=stand-in OURO_INTEGRATIONS_STAND_IN_DIR=$run/accounts OURO_TAILSCALE_STAND_IN_DIR=$run/tailscale \
    OURO_DEFAULT_FOLDER=$run/work OURO_PUBLIC_URL=http://127.0.0.1:$port HOME=$run/home \
    node --no-warnings "$repo/server/src/bin/ourod.ts" >> "$run/ourod.log" 2>&1 &
  ourod_pid=$!
  for _ in {1..50}; do /usr/bin/curl -sf "http://127.0.0.1:$port/v2/identity" >/dev/null && return; /bin/sleep 0.2; done
  echo "ourod did not start; see $run/ourod.log" >&2; exit 1
}
# A hard kill, as a crash or power loss would: the server says nothing to the open stream.
kill_ourod() { if [[ -n $ourod_pid ]]; then kill -KILL $ourod_pid 2>/dev/null || true; wait $ourod_pid 2>/dev/null || true; ourod_pid=; fi }
stop_ourod() { if [[ -n $ourod_pid ]]; then kill $ourod_pid 2>/dev/null || true; wait $ourod_pid 2>/dev/null || true; ourod_pid=; fi }
stop_runners() { local pid; for pid in $(pgrep -f "ouro-runner.ts $1/data" || true); do kill $pid 2>/dev/null || true; done }  # this run's agents; the runners outlive their ourod by design
trap 'stop_ourod; stop_runners "$run"' EXIT INT TERM HUP

rm -rf "$run"; mkdir -p "$run/data" "$run/work" "$run/home" "$run/accounts"
"$repo/scripts/ios-sim.sh" ${1:-}
# Keychain items outlive an uninstall, so a fresh install would otherwise still know the last run's server.
xcrun simctl keychain "$udid" reset
start_ourod
# The link carries a one-time pairing code: keep it out of output and logs.
link=$(OURO_SOCKET=$run/data/local.sock HOME=$run/home node --no-warnings "$repo/server/src/bin/ouro.ts" pair | sed -n 's/^link: //p')
out=$repo/.tools/maestro-out/m1-$(date +%Y%m%d-%H%M%S)
# zsh skips the EXIT trap when errexit fires inside a function, so a failed flow stops the server itself.
flow() {
  "$maestro" --device "$udid" test --test-output-dir "$out" "$@" 2>&1 | sed -E 's/code=[0-9a-f]+/code=REDACTED/g' && return
  stop_ourod; echo "flow failed: ${@[-1]:t}; screenshots in $out" >&2; exit 1
}

flow -e LINK="$link" "$flows/01-pair-with-link.yaml"
flow "$flows/02-new-agent-and-reply.yaml"
kill_ourod
flow "$flows/03a-chat-offline.yaml"
flow "$flows/03-send-while-server-down.yaml"
start_ourod
flow "$flows/04-retry-after-server-back.yaml"
flow "$flows/05-agents-list.yaml"
echo "M1 journey passed; screenshots in $out"
