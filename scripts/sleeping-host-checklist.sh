#!/usr/bin/env bash
# The sleeping-host checks to do by hand on a real run Sprite once the server with host holds (#80) is live there: what
# to look at, and the commands. Run it on the run Sprite. It only reads, except `start-long-turn`, which starts one
# agent for step 3.
#
#   scripts/sleeping-host-checklist.sh [status | watch | start-long-turn]
#
#   status           (default) the automatic checks, then the steps to do by hand
#   watch            every 15 s: the Sprite's tasks, agents at work, and the hold events ourod logged
#   start-long-turn  starts agent `hold-check`, whose turn lasts 7 minutes, longer than a hold's 5-minute expiry
#
# Settings: OURO_NEXT_ROOT (default ~/ouro-next), as for install-run-sprite.sh.
set -euo pipefail

root=${OURO_NEXT_ROOT:-$HOME/ouro-next}
home_dir=$root/home
api_socket=${OURO_SPRITE_API_SOCKET:-/.sprite/api.sock}
ourod_log=$home_dir/guardian/ourod.log
export OURO_SOCKET=$home_dir/data/local.sock
ouro=$home_dir/bin/ouro

say() { printf '==> %s\n' "$*"; }
check() { if eval "$2" >/dev/null 2>&1; then printf '  ok    %s\n' "$1"; else printf '  FAIL  %s\n' "$1"; fi; }

# The task ourod holds the Sprite with is named after its data directory, as ourod/bin does.
task_name="ouro-$(printf '%s' "$home_dir/data" | sha256sum | cut -c1-12)"
tasks() { curl -s --max-time 5 --unix-socket "$api_socket" http://sprite/v1/tasks 2>/dev/null || echo '(the Tasks API gave no list)'; }
hold_events() { grep -hoE '"event":"host_hold[a-z_]*"[^}]*' "$ourod_log" 2>/dev/null | tail -n "${1:-5}" || true; }
# `ouro list` says `running: <activity or tool>`; idle and waiting aren't work.
working() { "$ouro" list 2>/dev/null | grep 'running: ' | grep -vE 'running: (idle|waiting)' || echo '(no agent at work)'; }

status() {
  say "automatic checks"
  check "the Sprite's Tasks API is at $api_socket (so ourod holds the host: OURO_HOST_HOLD unset means sprite here)" "[ -S '$api_socket' ]"
  check "the guardian's configuration ($root/guardian.json) doesn't turn holds off" "[ -f '$root/guardian.json' ] && ! grep -q '\"OURO_HOST_HOLD\": *\"none\"' '$root/guardian.json'"
  check "ourod answers ($OURO_SOCKET)" "'$ouro' list"
  check "ourod's log is at $ourod_log" "[ -f '$ourod_log' ]"
  say "the Sprite's tasks now (ourod's is $task_name):"
  tasks; echo
  say "agents at work now:"
  working
  say "ourod's latest hold events (none is normal: refusals and failed renewals are what it logs):"
  hold_events 5
  cat <<STEPS

==> by hand, in order (watch with: scripts/sleeping-host-checklist.sh watch)

1. Idle lets go. With no agent at work and nothing waiting, $task_name leaves the task list within about 90 s
   of the last work. From another machine, the Sprite then shows as paused/cold (sprite list, or the Sprites dashboard)
   within a few minutes. Expect: no hold kept for FYIs, held agents or a computer long away.

2. A message wakes it. While it is paused, send any agent a message from the phone. Expect: the app connects (it may
   take a few seconds), the message is accepted with no error, the agent answers, and $task_name appears while it works.
   Then it goes again as in step 1.

3. A turn longer than a hold's expiry keeps running. Run: scripts/sleeping-host-checklist.sh start-long-turn
   Then leave the app closed. Expect: hold-check stays in its turn for 7 minutes and then replies "held through"; the
   task is renewed every 60 s (watch shows it throughout); the log shows no host_hold_not_renewed. Afterwards, step 1
   again. Archive hold-check when done: $ouro archive hold-check

4. A refused hold refuses the work, retryably. Not provoked on a real Sprite (it needs the Tasks API to refuse);
   covered by journeys/m6-sleeping-hosts.journey.ts. If a host_hold_refused event appears in the log on its own, note
   when, and what the phone showed (it should be a retryable error, the message kept in the composer's outbox).

5. With another computer joined (optional). A computer that sleeps is greeted only while it holds itself awake. Expect:
   after step 1, the other computer shows this one as offline, and doesn't wake it every 2 s (the Sprite stays paused).
   Sending one of its agents a message from the other computer wakes it, and the message arrives.

Report for each step: what was seen, the times, and the watch output around it.
STEPS
}

watch_loop() {
  while true; do
    printf '\n--- %s\n' "$(date -u +%H:%M:%S)"
    printf 'tasks: '; tasks; echo
    printf 'at work: '; working
    printf 'hold events: '; hold_events 3; echo
    sleep 15
  done
}

start_long_turn() {
  "$ouro" new --name hold-check --model "${OURO_NEXT_CHECK_MODEL:-sonnet}" \
    'Run the shell command `sleep 420` (7 minutes) in one go, without checking on it, then reply "held through" with ouro reply. Do nothing else.'
  say "started hold-check; watch with: scripts/sleeping-host-checklist.sh watch"
}

case "${1:-status}" in
  status) status ;;
  watch) watch_loop ;;
  start-long-turn) start_long_turn ;;
  *) echo 'usage: sleeping-host-checklist.sh [status | watch | start-long-turn]' >&2; exit 2 ;;
esac
