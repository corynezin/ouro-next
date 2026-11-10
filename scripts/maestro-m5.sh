#!/bin/zsh
# Runs the M5 journeys (Settings, Servers, Chats, Face ID lock, Archived and Unarchive) in ouro-rebirth-sim against a
# fresh local ourod on the stand-in model. Screenshots go to .tools/maestro-out, never to the repo.
set -euo pipefail
repo=${0:A:h:h}
port=${OURO_MAESTRO_PORT:-8797}
run=$repo/runs/maestro-m5
m1=$repo/apps/mobile/maestro/m1
flows=$repo/apps/mobile/maestro/m5
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
stop_runners() { local pid; for pid in $(pgrep -f "ouro-runner.ts $1/data" || true); do kill $pid 2>/dev/null || true; done }  # this run's agents; the runners outlive their ourod by design
# The Face ID setting lives in the app's container and would lock every later run, so the app leaves with the server.
clean_up() {
  if [[ -n $ourod_pid ]]; then kill $ourod_pid 2>/dev/null || true; wait $ourod_pid 2>/dev/null || true; ourod_pid=; fi
  stop_runners "$run"
  xcrun simctl uninstall "$udid" $app_id 2>/dev/null || true
}
trap clean_up EXIT INT TERM HUP
cli() { OURO_SOCKET=$run/data/local.sock HOME=$run/home node --no-warnings "$repo/server/src/bin/ouro.ts" "$@"; }
face() { xcrun simctl spawn "$udid" notifyutil -p com.apple.BiometricKit_Sim.pearl.$1; /bin/sleep 2; }
# Settings, opened over the app, sends it to the background without ending it; relaunching brings it back.
background_and_return() {
  xcrun simctl launch "$udid" com.apple.Preferences >/dev/null; /bin/sleep 3
  xcrun simctl launch "$udid" $app_id >/dev/null; /bin/sleep 3
  xcrun simctl terminate "$udid" com.apple.Preferences 2>/dev/null || true
}

rm -rf "$run"; mkdir -p "$run/data" "$run/work" "$run/home" "$run/accounts"
xcrun simctl uninstall "$udid" $app_id 2>/dev/null || true
"$repo/scripts/ios-sim.sh" ${1:-}
# Keychain items outlive an uninstall, so a fresh install would otherwise still know the last run's server.
xcrun simctl keychain "$udid" reset
xcrun simctl spawn "$udid" notifyutil -s com.apple.BiometricKit.enrollmentChanged 1
xcrun simctl spawn "$udid" notifyutil -p com.apple.BiometricKit.enrollmentChanged
start_ourod
# The link carries a one-time pairing code: keep it out of output and logs.
link=$(cli pair | sed -n 's/^link: //p')
out=$repo/.tools/maestro-out/m5-$(date +%Y%m%d-%H%M%S)
# zsh skips the EXIT trap when errexit fires inside a function, so a failed flow cleans up itself.
flow() {
  "$maestro" --device "$udid" test --test-output-dir "$out" "$@" 2>&1 | sed -E 's/code=[0-9a-f]+/code=REDACTED/g' && return
  clean_up; echo "flow failed: ${@[-1]:t}; screenshots in $out" >&2; exit 1
}

flow -e LINK="$link" "$m1/01-pair-with-link.yaml"
flow "$m1/02-new-agent-and-reply.yaml"
flow "$flows/01-settings-servers-chats.yaml"
flow "$flows/02-turn-on-face-id.yaml"
face match
xcrun simctl terminate "$udid" $app_id
xcrun simctl launch "$udid" $app_id >/dev/null; /bin/sleep 3
face nomatch
flow "$flows/03-locked-after-failed-match.yaml"
face match
flow "$flows/04-unlocked.yaml"
# A sheet under the lock: the failed answer goes in while lock-covers-sheets waits for it.
( /bin/sleep 12; face nomatch ) & answer_pid=$!
flow "$flows/lock-covers-sheets.yaml"
wait $answer_pid || true
background_and_return
face match
flow "$flows/lock-reopens-sheets.yaml"
cli archive greeter >/dev/null
flow "$flows/05-archived-then-unarchive.yaml"
echo "M5 journeys passed; screenshots in $out"
