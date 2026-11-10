#!/bin/zsh
# The P0 phone suite (docs/product-brief.md §12, "Phone UI"): onboarding, chat, failed send, asks and the update banner, in
# one command, on ouro-rebirth-sim against a fresh local ourod on the stand-in model. The flows are apps/mobile/maestro/p0.
#   scripts/maestro-p0.sh            installs this checkout's JS into the last simulator build, then runs the suite
#   scripts/maestro-p0.sh --native   rebuilds the native app first
# The update banner step publishes this checkout (plus a visible label change, in a throwaway worktree) to the local
# server. Screenshots go to .tools/maestro-out, never to the repo.
set -euo pipefail
repo=${0:A:h:h}
port=${OURO_MAESTRO_PORT:-8797}
run=$repo/runs/maestro-p0
flows=$repo/apps/mobile/maestro/p0
app_id=dev.claudeinbox.ouronext
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
publish_tree=$run/publish-src
stop_runners() { local pid; for pid in $(pgrep -f "ouro-runner.ts $1/data" || true); do kill $pid 2>/dev/null || true; done }  # this run's agents; the runners outlive their ourod by design
cleanup() { stop_ourod; stop_runners "$run"; git -C "$repo" worktree remove --force "$publish_tree" 2>/dev/null || true }
trap cleanup EXIT INT TERM HUP

rm -rf "$run"; mkdir -p "$run/data" "$run/work" "$run/home" "$run/accounts"
"$repo/scripts/ios-sim.sh" ${1:-}
# Keychain items outlive an uninstall, so a fresh install would otherwise still know the last run's server.
xcrun simctl keychain "$udid" reset
start_ourod
cli() { OURO_SOCKET=$run/data/local.sock HOME=$run/home node --no-warnings "$repo/server/src/bin/ouro.ts" "$@"; }
# The link carries a one-time pairing code: keep it out of output and logs.
link=$(cli pair | sed -n 's/^link: //p')
out=$repo/.tools/maestro-out/p0-$(date +%Y%m%d-%H%M%S)
# zsh skips the EXIT trap when errexit fires inside a function, so a failed flow cleans up itself.
flow() {
  "$maestro" --device "$udid" test --test-output-dir "$out" "$@" 2>&1 | sed -E 's/code=[0-9a-f]+/code=REDACTED/g' && return
  cleanup; echo "P0 flow failed: ${@[-1]:t}; screenshots in $out" >&2; exit 1
}

flow -e LINK="$link" "$flows/1-pair.yaml"
flow "$flows/2-chat.yaml"
kill_ourod
flow "$flows/3a-failed-send-offline.yaml"
flow "$flows/3b-failed-send.yaml"
start_ourod
flow "$flows/3c-failed-send-retry.yaml"
# Agent "asker" raises three asks through the stand-in, which runs a message's `standin:` steps as the agent.
cli new --name asker --model stand-in "Ask things" >/dev/null
cli send asker 'standin: [{"do":"run","command":"ouro ask human --choice Yes --choice No \"Ship it?\""},{"do":"run","command":"ouro ask human --blocked \"Need the API key\""},{"do":"run","command":"ouro ask human --urgent \"Server is down\""}]' >/dev/null
flow "$flows/4-asks.yaml"
# The update banner: publish a commit with a visible change from a throwaway worktree of this checkout's HEAD.
git -C "$repo" worktree add -q --detach "$publish_tree" HEAD
ln -s "$repo/node_modules" "$publish_tree/node_modules"; ln -s "$repo/apps/mobile/node_modules" "$publish_tree/apps/mobile/node_modules"
sed -i '' "s/'Ouro Next · JS over the air'/'Ouro Next · JS over the air · P0'/" "$publish_tree/apps/mobile/src/design/theme.ts"
git -C "$publish_tree" -c user.name=p0 -c user.email=p0@localhost commit -qam "P0: a visible label change"
cli publish --app "$publish_tree/apps/mobile" 2>&1 | tail -3
flow "$flows/5-update-banner.yaml"
echo "P0 suite passed; screenshots in $out"
