#!/bin/zsh
# Runs the parity flows (apps/mobile/maestro/parity) in ouro-rebirth-sim against a fresh local ourod on the stand-in
# model, after the M1 pair and new-agent flows. Evidence for docs/parity.md. Screenshots go to .tools/maestro-out.
set -euo pipefail
repo=${0:A:h:h}
port=${OURO_MAESTRO_PORT:-8797}
run=$repo/runs/maestro-parity
m1=$repo/apps/mobile/maestro/m1
flows=$repo/apps/mobile/maestro/parity
app_id=dev.claudeinbox.ouronext
export JAVA_HOME=$repo/.tools/jdk MAESTRO_CLI_NO_ANALYTICS=1 MAESTRO_CLI_ANALYSIS_NOTIFICATION_DISABLED=true
maestro=$repo/.tools/maestro/bin/maestro
[[ -x $maestro && -x $JAVA_HOME/bin/java ]] || { echo "Maestro and a JDK are expected in .tools (see apps/mobile/maestro/README.md)" >&2; exit 1; }
if lsof -nP -iTCP:$port -sTCP:LISTEN >/dev/null; then echo "port $port is in use; set OURO_MAESTRO_PORT" >&2; exit 1; fi
# One zsh glob only: a pattern that matches no flow must fail, not pass with nothing run.
matching_flows=("$flows"/${~OURO_PARITY_FLOWS:-[0-9]*.yaml}(N))
(( ${#matching_flows} )) || { echo "OURO_PARITY_FLOWS=${OURO_PARITY_FLOWS:-} matches no flow in $flows (one zsh glob, no spaces or braces)" >&2; exit 1; }
simulator=${OURO_SIM:-ouro-rebirth-sim}
udid=$(xcrun simctl list devices | awk -F'[()]' -v name="$simulator" '$0 ~ "^ +"name" " {print $2; exit}')
[[ -n $udid ]] || { echo "no simulator named $simulator" >&2; exit 1; }

ourod_pid=
start_ourod() {
  mkdir -p "$run/accounts"; printf 'sk-or-accepted\nsk-ant-accepted\nghp_accepted\nclaude-code-accepted\n' > "$run/accounts/accepted"
  # The parity flows make more agents than the default limit of 8 running.
  OURO_DATA=$run/data OURO_APP_LISTEN=tcp:$port OURO_MACHINE_NAME=maestro OURO_DEFAULT_MODEL=stand-in OURO_AGENT_LIMIT=40 OURO_INTEGRATIONS_STAND_IN_DIR=$run/accounts OURO_TAILSCALE_STAND_IN_DIR=$run/tailscale \
    OURO_DEFAULT_FOLDER=$run/work OURO_PUBLIC_URL=http://127.0.0.1:$port OURO_PEER_ADDRESS=127.0.0.1:$port HOME=$run/home \
    node --no-warnings "$repo/server/src/bin/ourod.ts" >> "$run/ourod.log" 2>&1 &
  ourod_pid=$!
  for _ in {1..50}; do /usr/bin/curl -sf "http://127.0.0.1:$port/v2/identity" >/dev/null && return; /bin/sleep 0.2; done
  echo "ourod did not start; see $run/ourod.log" >&2; exit 1
}
stop_ourod() { if [[ -n $ourod_pid ]]; then kill $ourod_pid 2>/dev/null || true; wait $ourod_pid 2>/dev/null || true; ourod_pid=; fi }
ourod2_pid=
run2=$repo/runs/maestro-parity-second
port2=$((port + 1))
# A second server, so the phone has two (Servers rows). Its link carries a pairing code: kept out of output.
start_second_ourod() {
  if lsof -nP -iTCP:$port2 -sTCP:LISTEN >/dev/null; then echo "port $port2 is in use" >&2; exit 1; fi
  rm -rf "$run2"; mkdir -p "$run2/data" "$run2/work" "$run2/home" "$run2/accounts"
  OURO_DATA=$run2/data OURO_APP_LISTEN=tcp:$port2 OURO_MACHINE_NAME=second OURO_DEFAULT_MODEL=stand-in OURO_INTEGRATIONS_STAND_IN_DIR=$run2/accounts OURO_TAILSCALE_STAND_IN_DIR=$run2/tailscale \
    OURO_DEFAULT_FOLDER=$run2/work OURO_PUBLIC_URL=http://127.0.0.1:$port2 HOME=$run2/home \
    node --no-warnings "$repo/server/src/bin/ourod.ts" >> "$run2/ourod.log" 2>&1 &
  ourod2_pid=$!
  for _ in {1..50}; do /usr/bin/curl -sf "http://127.0.0.1:$port2/v2/identity" >/dev/null && break; /bin/sleep 0.2; done
  link2=$(OURO_SOCKET=$run2/data/local.sock HOME=$run2/home node --no-warnings "$repo/server/src/bin/ouro.ts" pair | sed -n 's/^link: //p')
}
stop_ourod2() { if [[ -n $ourod2_pid ]]; then kill $ourod2_pid 2>/dev/null || true; wait $ourod2_pid 2>/dev/null || true; ourod2_pid=; fi }
stop_runners() { local pid; for pid in $(pgrep -f "ouro-runner.ts $1/data" || true); do kill $pid 2>/dev/null || true; done }  # this run's agents; the runners outlive their ourod by design
trap 'stop_ourod; stop_ourod2; stop_runners "$run"; stop_runners "$run2"' EXIT INT TERM HUP

rm -rf "$run"; mkdir -p "$run/data" "$run/work" "$run/home" "$run/accounts"
# A fresh install, so defaults are what a new phone sees.
xcrun simctl uninstall "$udid" $app_id 2>/dev/null || true
"$repo/scripts/ios-sim.sh" ${1:-}
# Keychain items outlive an uninstall, so a fresh install would otherwise still know the last run's server.
xcrun simctl keychain "$udid" reset
start_ourod
# The link carries a one-time pairing code: keep it out of output and logs.
link=$(OURO_SOCKET=$run/data/local.sock HOME=$run/home node --no-warnings "$repo/server/src/bin/ouro.ts" pair | sed -n 's/^link: //p')
out=$repo/.tools/maestro-out/parity-$(date +%Y%m%d-%H%M%S)
# zsh skips the EXIT trap when errexit fires inside a function, so a failed flow stops the server itself.
flow() {
  "$maestro" --device "$udid" test --test-output-dir "$out" "$@" 2>&1 | sed -E 's/code=[0-9a-f]+/code=REDACTED/g' && return
  stop_ourod; stop_ourod2; stop_runners "$run"; stop_runners "$run2"; echo "flow failed: ${@[-1]:t}; screenshots in $out" >&2; exit 1
}

cli() { OURO_SOCKET=$run/data/local.sock HOME=$run/home node --no-warnings "$repo/server/src/bin/ouro.ts" "$@"; }
# Agent "asker" raises three asks through the stand-in, which runs a message's `standin:` steps as the agent.
raise_asks() {
  cli new --name asker --model stand-in "Ask things" >/dev/null
  cli send asker 'standin: [{"do":"run","command":"ouro ask human --choice Yes --choice No \"Ship it?\""},{"do":"run","command":"ouro ask human --blocked \"Need the API key\""},{"do":"run","command":"ouro ask human --urgent \"Server is down\""}]' >/dev/null
}

flow "$flows/00-pair-form.yaml"
flow -e LINK="$link" "$m1/01-pair-with-link.yaml"
flow "$m1/02-new-agent-and-reply.yaml"
# OURO_PARITY_FLOWS narrows the run to some flows, such as "5[0-9]-*.yaml"; the pair form always runs first.
setopt null_glob
# A 160×120 orange PNG, for the files flow.
PIC_PNG=iVBORw0KGgoAAAANSUhEUgAAAKAAAAB4CAIAAAD6wG44AAAAzElEQVR42u3RMQ0AAAzDsPL/h3flUVkKgjh/0XAWABZgARZgARZgAQYswAIswAIswAIMWIAFWIAFWIAFWIABC7AAC7AAC7AAAxZgARZgARZgAQYswAIswAIswAIswIAFWIAFWIAFWIABC7AAC7AAC7AAA7YAsAALsAALsAALMGABFmABFmABFmDAAizAAizAAizAAgxYgAVYgAVYgAUYsAALsAALsAALMGABFmABFmABFmABBizAAizAAizAAgxYgAVYgAVYgAUYsAvTFSxDYusB6qScAAAAAElFTkSuQmCC
for f in "$flows"/${~OURO_PARITY_FLOWS:-[0-9]*.yaml}; do
  flow_args=()
  # What to run once the flow has passed, such as starting the server again.
  after_flow=()
  case ${f:t} in
    00-*) continue ;;
    # Fresh one-time links; flow() keeps their codes out of the output.
    11-*) link11=$(cli pair | sed -n 's/^link: //p')
          flow_args=(-e LINK="$link11" -e BAD_LINK="$(print -r -- $link11 | sed -E 's/code=[0-9a-zA-Z]+/code=0000/')") ;;
    # The link goes on the simulator's clipboard, with the reference's scheme: the parser accepts any.
    12-*) cli pair | sed -n 's/^link: //p' | sed 's|^ouronext://|claudeinbox://|' | tr -d '\n' | xcrun simctl pbcopy "$udid" ;;
    04-*) raise_asks ;;
    10-*) cli new --name worker --model stand-in "Work" >/dev/null
          cli goal set --for worker "Keep tidy" >/dev/null
          cli send worker 'standin: [{"do":"barrier","name":"hold"}]' >/dev/null ;;
    70-*) cli new --name speaker --model stand-in "Chat" >/dev/null
          cli send speaker 'standin: [{"do":"run","command":"ouro reply \"This is a deliberately long paragraph so that the bubble has to wrap onto several lines and we can check the width stays inside the screen for the long paragraph row.\""}]' >/dev/null
          /bin/sleep 4 ;;
    71-*) cli new --name speaker --model stand-in "Chat" >/dev/null 2>&1 || true ;;
    13-*) cli new --name formatter --model stand-in "Format" >/dev/null
          cli send formatter "standin: [{\"do\":\"run\",\"command\":\"ouro reply \\\"\$(cat $flows/fixtures/markdown.md)\\\"\"}]" >/dev/null ;;
    14-*) cli new --name helper --model stand-in "Help" >/dev/null
          cli chats new team helper >/dev/null
          cli send helper 'standin: [{"do":"run","command":"ouro send \"#team\" \"Hello team\""},{"do":"run","command":"ouro ask human \"Need a hand?\""}]' >/dev/null
          cli new --name sleeper --model stand-in "Sleep" >/dev/null
          cli stop sleeper >/dev/null
          cli send master 'standin: [{"do":"run","command":"ouro reply \"Ask zulu, alpha, mybot@maestro and asker, then formatter; not mybots.\""},{"do":"run","command":"ouro ask human \"Master question?\""}]' >/dev/null
          cli new --name alpha --model stand-in "First" >/dev/null
          cli new --name zulu --model stand-in "Second" >/dev/null ;;
    50-*)
      cli new --name goalie --model stand-in "Do work" >/dev/null
      cli goal set --for goalie --check true --every 3600 "Ship the thing" >/dev/null
      cli new --name oddity --model stand-in "Wander" >/dev/null
      cli goal set --for oddity --open-ended --every 90 "Wander" >/dev/null ;;
    51-*)
      # Goal cycles from flow 50's agents would move rows in the chats list while it is tapped.
      cli goal clear --for goalie >/dev/null 2>&1 || true
      cli goal clear --for oddity >/dev/null 2>&1 || true
      cli new --name worker --model stand-in "Do work" >/dev/null
      cli new --name helper --model stand-in "Help" >/dev/null
      cli chats new Crew greeter worker >/dev/null
      cli send worker 'standin: [{"do":"run","command":"ouro send \"#Crew\" \"worker here: lunch?\""},{"do":"run","command":"ouro chats new Backroom helper"},{"do":"run","command":"ouro send \"#Backroom\" \"psst helper\""}]' >/dev/null
      cli send helper 'standin: [{"do":"run","command":"ouro send --fyi worker \"quick question\""}]' >/dev/null
      /bin/sleep 8 ;;
    54-*)
      # Agents to pick; already there when 51 ran in the same run.
      cli new --name helper --model stand-in "Help" >/dev/null 2>&1 || true
      cli new --name worker --model stand-in "Do work" >/dev/null 2>&1 || true ;;
    57-*)
      cli new --name finisher --model stand-in "Finish up" >/dev/null
      cli send finisher 'standin: [{"do":"run","command":"ouro done \"All wrapped up\""}]' >/dev/null
      cli new --name busybody --model stand-in "Stay busy" >/dev/null
      cli send busybody 'standin: [{"do":"run","command":"sleep 300"}]' >/dev/null
      /bin/sleep 6 ;;
    60-*)
      cli new --name noter --model stand-in "Garden" >/dev/null
      cli goal set --for noter --check false --every 60 "Tidy the garden" >/dev/null
      noter_dir=$run/data/agents/$(sqlite3 "$run/data/ouro.db" "select id from agents where name='noter'")
      mkdir -p "$noter_dir"
      echo "Found three weeds; will pull them next cycle." > "$noter_dir/goal-notes.md" ;;
    64-*)
      # What the stand-in Codex reads as the plan's usage once signed in: the 5-hour window, 12% used.
      print -r -- '[{"windowMinutes":300,"usedFraction":0.12,"resetsAt":null,"status":null}]' > "$run/accounts/chatgpt-usage.json"
      # The stand-in picks a random ChatGPT code; enter it 12 s after it appears, so the flow can see the code screen first.
      ( for _ in {1..120}; do
          code=$(jq -r '.chatgptPendingCode // empty' "$run/accounts/state.json" 2>/dev/null || true)
          if [[ -n $code ]]; then /bin/sleep 12; print -r -- "$code" > "$run/accounts/chatgpt-entered"; break; fi
          /bin/sleep 1
        done ) &
      chatgpt_watcher_pid=$! ;;
    65-*)
      # A friend with one phone: invite "ann", then pair as her over HTTP. The code stays in a variable, out of logs.
      ann_code=$(cli pair --invite ann | sed -n 's/^code: //p')
      /usr/bin/curl -sf -X POST "http://127.0.0.1:$port/v2/pair" -H 'content-type: application/json' \
        -d "{\"code\":\"$ann_code\",\"deviceName\":\"Ann's phone\"}" >/dev/null ;;
    58-*|90-*)
      start_second_ourod
      flow_args=(-e LINK2="$link2") ;;
    56-*)
      cli new --name retired --model stand-in "Old job done" >/dev/null
      cli new --name second --model stand-in "Another" >/dev/null
      cli archive retired >/dev/null
      cli archive second >/dev/null
      cli new --name second --model stand-in "Takes the name" >/dev/null ;;
    20-*)
      cli new --name header --model stand-in "Header" >/dev/null
      cli goal set --for header "Keep the header tidy" >/dev/null
      cli new --name pinger --model stand-in "Ping" >/dev/null
      # stays unread: Next unread needs one
      cli new --name pingtwo --model stand-in "Ping again" >/dev/null
      /bin/sleep 4 ;;
    21-*)
      cli new --name talker --model stand-in "Talk" >/dev/null
      /bin/sleep 3
      cli send talker 'standin: [{"do":"run","command":"ouro reply \"See https://example.com/talk for more\""},{"do":"run","command":"sleep 60"}]' >/dev/null ;;
    22-*)
      cli new --name chatty --model stand-in "Chat" >/dev/null
      cli send chatty 'standin: [{"do":"run","command":"for i in $(seq -w 1 70); do ouro reply \"hist$i\"; done"}]' >/dev/null
      # Its turn is over once it is idle again.
      /bin/sleep 2
      for _ in {1..90}; do cli list | grep -q '^chatty  running: idle' && break; /bin/sleep 1; done ;;
    23-*)
      # A chat the phone has listed but never opened, so its first page fails to load while the server is down.
      cli new --name unopened --model stand-in "Wait" >/dev/null
      /bin/sleep 4
      stop_ourod
      after_flow=(start_ourod) ;;
    88a-*)
      # J-22/J-23: the server is down while the phone has a chat open, and comes back for 88b.
      stop_ourod
      after_flow=(start_ourod) ;;
    88b-*)
      # Said while the phone was catching up: it must arrive once the stream is back.
      cli send greeter 'standin: [{"do":"run","command":"ouro reply \"back after restart\""}]' >/dev/null ;;
    24-*)
      mkdir -p "$run/files"
      print -r -- $PIC_PNG | base64 -D > "$run/files/pic.png"
      print -r -- 'Notes for the file screen.' > "$run/files/notes.txt"
      xcrun simctl addmedia "$udid" "$run/files/pic.png"
      xcrun simctl privacy "$udid" revoke camera $app_id
      cli new --name filer --model stand-in "Files" >/dev/null
      cli send filer "standin: [{\"do\":\"run\",\"command\":\"ouro reply --file $run/files/pic.png --file $run/files/notes.txt \\\"Two files\\\"\"}]" >/dev/null ;;
    30-*)
      cli new --name roomie --model stand-in "Room" >/dev/null
      cli new --name roomer --model stand-in "Room too" >/dev/null
      cli chats new Quiet roomie >/dev/null
      cli chats new Lounge roomie roomer >/dev/null
      cli send roomie 'standin: [{"do":"run","command":"ouro send \"#Lounge\" \"roomie says hi\""},{"do":"run","command":"ouro chats new Annex roomer"}]' >/dev/null
      cli send roomer 'standin: [{"do":"run","command":"ouro send \"#Lounge\" \"roomer says hi\""}]' >/dev/null
      /bin/sleep 6 ;;
    35-*)
      cli new --name pauser --model stand-in "Pause" >/dev/null
      cli goal set --for pauser "Paused goal" >/dev/null
      cli goal pause --for pauser "Waiting on you" >/dev/null
      cli new --name completer --model stand-in "Complete" >/dev/null
      cli goal set --for completer "Done goal" >/dev/null
      cli goal done --for completer "finished" >/dev/null
      cli new --name cycler --model stand-in "Cycle" >/dev/null
      cli goal set --for cycler --every 600 "Cycle slowly" >/dev/null
      cli new --name liner --model stand-in "Lines" >/dev/null
      cli send liner 'standin: [{"do":"run","command":"ouro reply \"first line\nsecond line\nthird line\""}]' >/dev/null
      cli new --name quietone --model stand-in "Hold" >/dev/null
      cli send quietone 'standin: [{"do":"barrier","name":"never"}]' >/dev/null
      cli send quietone "you said this last" >/dev/null
      /bin/sleep 6 ;;
    39-*)
      # Revoke this phone (the only paired device so far), and put a fresh link on the clipboard to pair again.
      cli devices revoke "$(cli devices | sed -n 's/.*(\([^)]*\))$/\1/p' | head -1)" >/dev/null
      cli pair | sed -n 's/^link: //p' | tr -d '\n' | xcrun simctl pbcopy "$udid" ;;
    80-*)
      # A fresh install: the keychain outlives clearState, so it goes too. A fresh link pairs again at the end.
      xcrun simctl keychain "$udid" reset
      flow_args=(-e LINK="$(cli pair | sed -n 's/^link: //p')") ;;
    82-*)
      # Tailscale's stand-in: approve the login 12 s after it starts, so the flow sees "Approve the login" first.
      mkdir -p "$run/tailscale"
      ( for _ in {1..120}; do
          if [[ "$(jq -r '.loginStartedAs // empty' "$run/tailscale/state.json" 2>/dev/null || true)" != "" ]]; then
            /bin/sleep 12; : > "$run/tailscale/approved"; break
          fi
          /bin/sleep 1
        done ) &
      tailscale_watcher_pid=$! ;;
    83-*)
      flow "$flows/_allow-notifications.yaml"
      cli new --name pusher --model stand-in "Push" >/dev/null
      /bin/sleep 4
      # The payload the server sends: `ouro` beside `aps`, with this phone's device id on this server.
      push_device=$(sqlite3 "$run/data/ouro.db" "select id from devices where revoked_at is null and purpose = 'phone' order by paired_at desc limit 1")
      push_agent=$(sqlite3 "$run/data/ouro.db" "select id from agents where name = 'pusher'")
      push_chat=$(sqlite3 "$run/data/ouro.db" "select chat_id from chat_members where address = 'pusher' limit 1")
      push_message=$(sqlite3 "$run/data/ouro.db" "select id from messages where chat_id = '$push_chat' order by seq desc limit 1")
      push_payload() { print -r -- "{\"aps\":{\"alert\":{\"title\":\"pusher\",\"body\":\"$1\"},\"sound\":\"default\"},\"ouro\":{\"deviceId\":\"$push_device\",\"subject\":{\"kind\":\"message\",\"chatId\":\"$push_chat\",\"messageId\":\"$push_message\",\"agentId\":\"$push_agent\"}}}" > "$run/push.json"; xcrun simctl push "$udid" $app_id "$run/push.json"; }
      # Maestro takes a variable time to start, and a banner lasts a few seconds: so the first push repeats until the flow has
      # tapped one, then "Again" repeats while pusher's chat is open (a banner for a chat on screen is suppressed).
      ( for _ in {1..10}; do push_payload "Push from pusher"; /bin/sleep 4; done; /bin/sleep 6; for _ in {1..14}; do push_payload "Again from pusher"; /bin/sleep 3; done ) &
      push_pid=$! ;;
    86-*)
      cli new --name usage --model stand-in "Use the plan" >/dev/null
      resets=$(( $(date +%s) * 1000 + 3 * 3600000 ))
      cli send usage "standin: [{\"do\":\"plan_usage\",\"windows\":[{\"windowMinutes\":300,\"usedFraction\":0.2,\"resetsAt\":$resets,\"status\":\"allowed\"},{\"windowMinutes\":10080,\"usedFraction\":0.07,\"resetsAt\":$(( resets + 86400000 )),\"status\":\"allowed\"}]}]" >/dev/null
      /bin/sleep 6 ;;
    07-*) cli send asker 'standin: [{"do":"run","command":"ouro reply \"Tidying up\""},{"do":"run","command":"ouro done \"Everything is tidy\""}]' >/dev/null ;;
  esac
  flow "${flow_args[@]}" "$f"
  if (( ${#after_flow} )); then "${after_flow[@]}"; fi
  if [[ -n ${chatgpt_watcher_pid:-} ]]; then kill $chatgpt_watcher_pid 2>/dev/null || true; chatgpt_watcher_pid=; fi
  if [[ -n ${tailscale_watcher_pid:-} ]]; then kill $tailscale_watcher_pid 2>/dev/null || true; tailscale_watcher_pid=; fi
  if [[ -n ${push_pid:-} ]]; then kill $push_pid 2>/dev/null || true; push_pid=; fi
done
echo "parity flows passed; screenshots in $out"
