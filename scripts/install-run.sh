#!/usr/bin/env bash
# Installs, or moves to another commit, the server: the person's copy of the source, then two services, run by one of
# three service managers. `<prefix>-host` starts runners, and `<prefix>-guardian` builds, runs and watches releases and
# answers the server's HTTP port. Running it again with the same commit changes nothing; with another commit it deploys
# that commit. Its wrappers set up each kind of machine and then run it:
#   install-run-sprite.sh   a run Sprite (sprite-env services)
#   install-run-ubuntu.sh   an Ubuntu machine such as an EC2 instance (systemd units, behind Caddy)
#   install-run-mac.sh      a Mac (the person's launch agents, reached over Tailscale)
#
#   scripts/install-run.sh <commit>
#
# Settings, as environment variables:
#   OURO_NEXT_SERVICES       what runs the services: sprite (sprite-env), systemd (system units run as this user,
#                            through sudo) or launchd (this user's launch agents, on a Mac) (required)
#   OURO_NEXT_PUBLIC_URL     where phones and other computers reach this server, used in pairing links (required). A re-run
#                            that would change it stops instead, unless OURO_NEXT_MOVE_PUBLIC_URL=yes.
#   OURO_NEXT_ROOT           where everything lives (default ~/ouro)
#   OURO_NEXT_DEFAULT_MODEL  the model new agents use (default: the server's own default)
#   OURO_NEXT_REPO           what to clone when <root>/source doesn't exist yet (required then)
#   OURO_NEXT_SERVICE_PREFIX service names (default ouro)
#   OURO_NEXT_LISTEN_PORT    the guardian's port (default 8080)
#   OURO_NEXT_LISTEN_HOST    the address the guardian's port binds to (default 0.0.0.0, every interface)
#   OURO_NEXT_HTTP_PORT      sprite only: the port the Sprite's URL routes to; empty to leave its routing alone (default 8080)
#   OURO_NEXT_APNS_TEAM_ID   the Apple team of the APNs key (default U2Q2D6ZQP2, the app's team)
#   OURO_NEXT_BASE_REPO      a public git repository of bases, which this server takes bases from (default: none)
#   OURO_NEXT_KEEP_AWAKE     on: with launchd, the Mac doesn't sleep when idle while the runner host runs (default off)
#   OURO_NEXT_MACHINE_NAME   this computer's name, to the person and its other computers (default: the hostname)
#   OURO_NEXT_PEER_ADDRESS   where the person's other computers reach this one (default: the public URL, as the server takes it)
#
# Push notifications: put the team's APNs key in <root>/apns/AuthKey_<key id>.p8 (mode 600), as Apple names it. The key
# id comes from that name; only the path reaches the server's configuration, never the key.
set -euo pipefail

install_name=install-run
# shellcheck source=lib/install-common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/install-common.sh"

commit_wanted=${1:?usage: install-run.sh <commit>}
service_manager=${OURO_NEXT_SERVICES:-}
public_url=${OURO_NEXT_PUBLIC_URL:-}
root=${OURO_NEXT_ROOT:-$ouro_default_root}
repo=${OURO_NEXT_REPO:-}
prefix=${OURO_NEXT_SERVICE_PREFIX:-$ouro_default_service_prefix}
listen_port=$ouro_listen_port
listen_host=${OURO_NEXT_LISTEN_HOST:-0.0.0.0}
http_port=${OURO_NEXT_HTTP_PORT-8080}
sprite_env=${OURO_NEXT_SPRITE_ENV:-sprite-env}
peer_address=${OURO_NEXT_PEER_ADDRESS:-}

source_dir=$root/source
home_dir=$root/home
stable_dir=$root/stable
state_dir=$root/install
config=$root/guardian.json
host_service=$prefix-host
guardian_service=$prefix-guardian
host_socket=$home_dir/runner-host.sock

# macOS has shasum, not sha256sum.
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

# launchd services run only in the person's login session (gui/<uid>, session type Aqua), which also loads
# ~/Library/LaunchAgents by itself at each login. Bootstrapped into their background domain (user/<uid>, over SSH with no one logged in) it
# would be loaded a second time into gui/<uid> at the next login: two hosts and two guardians on one socket and port.
# So the plist is limited to Aqua, and an install with no one logged in is refused.
launchd_gui_domain() { printf 'gui/%s' "$(id -u)"; }
launchd_domain_or_refuse() {
  local domain
  domain=$(launchd_gui_domain)
  launchctl print "$domain" >/dev/null 2>&1 ||
    fail "no one is logged in to this Mac as $(id -un), so its launch agents have nowhere to run. Log in (at the Mac, through Screen Sharing, or with automatic login), then run this again; over SSH works while you're logged in"
  printf '%s' "$domain"
}
case $service_manager in
  sprite) command -v "$sprite_env" >/dev/null || fail "$sprite_env isn't here, so this isn't a Sprite (see install-run-ubuntu.sh or install-run-mac.sh)" ;;
  systemd) command -v systemctl >/dev/null || fail "systemctl isn't here"; sudo -n true 2>/dev/null || fail "systemd services need sudo without a password" ;;
  launchd) command -v launchctl >/dev/null || fail "launchctl isn't here"; launchd_domain=$(launchd_domain_or_refuse) ;;
  '') fail "set OURO_NEXT_SERVICES (sprite, systemd or launchd), or run install-run-sprite.sh, install-run-ubuntu.sh or install-run-mac.sh" ;;
  *) fail "OURO_NEXT_SERVICES must be sprite, systemd or launchd, not $service_manager" ;;
esac
[ -n "$public_url" ] || fail "set OURO_NEXT_PUBLIC_URL to where phones and other computers reach this server"
require_node_needed node
node_bin=$(command -v node)
command -v git >/dev/null || fail "git isn't installed"
command -v npm >/dev/null || fail "npm isn't installed"
# Only a Sprite routes its URL to a port; elsewhere Caddy or the tailnet reach the guardian's port directly.
if [ "$service_manager" != sprite ]; then http_port=; fi
refuse_public_url_change "$root" "$public_url"
mkdir -p "$root" "$home_dir" "$stable_dir" "$state_dir"

# 1. The person's copy of the source, at the commit. Agents edit it later, so never discard their uncommitted work.
export GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}
if [ ! -d "$source_dir/.git" ]; then
  [ -n "$repo" ] || fail "no copy of the source at $source_dir; set OURO_NEXT_REPO to what to clone"
  say "cloning $repo"
  git clone --quiet "$repo" "$source_dir"
fi
git -C "$source_dir" fetch --quiet origin
commit=$(git -C "$source_dir" rev-parse --verify --quiet "$commit_wanted^{commit}") || fail "no commit $commit_wanted in $source_dir"
# The guardian builds the `main` branch, so the source must be on it even when the clone checked out another branch.
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$commit" ] || [ "$(git -C "$source_dir" symbolic-ref --quiet --short HEAD)" != main ]; then
  [ -z "$(git -C "$source_dir" status --porcelain)" ] || fail "$source_dir has uncommitted changes; commit or remove them first"
  say "source to $commit"
  git -C "$source_dir" checkout --quiet -B main "$commit"
fi

# 2. Dependencies, which releases copy from the source.
lock_hash=$(sha256_of "$source_dir/package-lock.json")
if [ ! -d "$source_dir/node_modules" ] || [ "$(cat "$state_dir/installed-lock" 2>/dev/null)" != "$lock_hash" ]; then
  say "installing dependencies"
  (cd "$source_dir" && npm ci --no-audit --no-fund --loglevel=error)
  echo "$lock_hash" > "$state_dir/installed-lock"
fi

# 3. Stable copies of the guardian and the runner host, which releases never replace. Named by content, so a copy in use
#    never changes underneath its service.
guardian_tree=$(git -C "$source_dir" rev-parse "$commit:guardian")
guardian_copy=$stable_dir/guardian-$guardian_tree
if [ ! -d "$guardian_copy" ]; then
  mkdir -p "$guardian_copy.partial"
  git -C "$source_dir" archive "$commit" guardian | tar -x -C "$guardian_copy.partial" --strip-components=1
  mv "$guardian_copy.partial" "$guardian_copy"
fi
host_blob=$(git -C "$source_dir" rev-parse "$commit:guardian/src/runner-host.ts")
host_copy=$stable_dir/runner-host-$host_blob
if [ ! -d "$host_copy" ]; then
  mkdir -p "$host_copy.partial"
  git -C "$source_dir" show "$commit:guardian/src/runner-host.ts" > "$host_copy.partial/runner-host.ts"
  echo '{ "type": "module" }' > "$host_copy.partial/package.json"
  mv "$host_copy.partial" "$host_copy"
fi

# 4. The guardian's configuration. Production timing: the guardian's own defaults.
apns_keys=("$root"/apns/AuthKey_*.p8)
apns_key_file=
if [ -e "${apns_keys[0]}" ]; then
  [ "${#apns_keys[@]}" -eq 1 ] || fail "more than one APNs key in $root/apns: keep only the one to use"
  apns_key_file=${apns_keys[0]}
  apns_key_id=$(basename "$apns_key_file" .p8)
  apns_key_id=${apns_key_id#AuthKey_}
  say "push notifications: APNs key $apns_key_id"
else
  say "push notifications: off (no APNs key in $root/apns)"
fi
base_repo=${OURO_NEXT_BASE_REPO:-}
if [ -n "$base_repo" ]; then say "bases: taken from $base_repo"; fi
OURO_NEXT_CONFIG_JSON=$(
  BASE_REPO=$base_repo \
  ROOT_HOME=$home_dir SOURCE=$source_dir PORT=$listen_port LISTEN_HOST=$listen_host URL=$public_url SOCKET=$host_socket MODEL=${OURO_NEXT_DEFAULT_MODEL:-} \
    APNS_KEY_FILE=$apns_key_file APNS_KEY_ID=${apns_key_id:-} APNS_TEAM_ID=${OURO_NEXT_APNS_TEAM_ID:-U2Q2D6ZQP2} \
    MACHINE=${OURO_NEXT_MACHINE_NAME:-$(hostname)} PEER=$peer_address SERVICES=$service_manager "$node_bin" -e '
      const env = process.env
      // Tailscale is the Sprite way in; a machine of its own under systemd can still join the Tailscale network of the
      // person. A Mac has the Tailscale app, which the person signs in to themselves.
      const ourodEnv = { OURO_RUNNER_HOST_SOCKET: env.SOCKET }
      if (env.SERVICES === "sprite" || env.SERVICES === "systemd") ourodEnv.OURO_TAILSCALE = env.SERVICES
      if (env.PEER) ourodEnv.OURO_PEER_ADDRESS = env.PEER
      if (env.MODEL) ourodEnv.OURO_DEFAULT_MODEL = env.MODEL
      if (env.BASE_REPO) ourodEnv.OURO_BASE_REPO = env.BASE_REPO
      if (env.APNS_KEY_FILE) Object.assign(ourodEnv, { OURO_APNS_KEY_FILE: env.APNS_KEY_FILE, OURO_APNS_KEY_ID: env.APNS_KEY_ID, OURO_APNS_TEAM_ID: env.APNS_TEAM_ID })
      // Only an address other than the guardian's default is written, so the configuration of a server installed before
      // stays the same, and its guardian isn't restarted for nothing.
      const listen = env.LISTEN_HOST === "0.0.0.0" ? {} : { listenHost: env.LISTEN_HOST }
      process.stdout.write(JSON.stringify({ home: env.ROOT_HOME, listenPort: Number(env.PORT), ...listen, sourceDir: env.SOURCE, appSourceDir: env.SOURCE + "/apps/mobile", sourceBranch: "main",
        machineName: env.MACHINE, publicUrl: env.URL, ourodEnv }, null, 2) + "\n")'
)
if [ "$(cat "$config" 2>/dev/null)" != "$OURO_NEXT_CONFIG_JSON" ]; then
  say "writing $config"
  printf '%s\n' "$OURO_NEXT_CONFIG_JSON" > "$config.partial"
  mv "$config.partial" "$config"
fi
config_hash=$(sha256_of "$config")

# 5. The services. Each is recreated only when its definition changes. Recreating the runner host ends every runner,
#    so it happens only when the host itself changes; agents then restart and resume their conversations.
#    Services run with this PATH, without any Ouro's command shims: run from an agent's shell, the agent's `ouro` comes
#    first, and baking it in would also change the host's definition, replacing the host and ending every runner.
#    Dropped: this server's <root>/home and anything under it, any Ouro's home/bin (a guardian.sock beside it), and
#    agents' .claude-inbox directories.
service_path_of() { # <PATH>
  local dir kept= entries
  IFS=: read -ra entries <<< "$1"
  for dir in "${entries[@]}"; do
    case $dir in ''|"$home_dir"|"$home_dir"/*|*.claude-inbox*) continue ;; esac
    if [ -S "$(dirname "$dir")/guardian.sock" ]; then continue; fi
    kept=${kept:+$kept:}$dir
  done
  printf '%s' "$kept"
}
service_path=$(service_path_of "$PATH")
service_env="PATH=$service_path,HOME=$HOME"
# The three service managers, each as `<manager>_services create|delete <name> [options]` with sprite-env's options
# (--cmd, --args, --env, --dir, --needs, --http-port, --no-stream), and `<manager>_service_exists <name>`.

# sprite-env, on a Sprite. It reports a refusal as an error event and still exits 0.
sprite_services() {
  local output
  output=$("$sprite_env" services "$@" 2>&1) || fail "sprite-env services $1 $2 failed: $output"
  if printf '%s' "$output" | grep -q '"type":"error"'; then fail "sprite-env services $1 $2 failed: $output"; fi
}
sprite_service_exists() { "$sprite_env" services get "$1" >/dev/null 2>&1; }

# systemd: a system unit run as this user. `--http-port` is a Sprite's own; `--no-stream` is how these run anyway.
unit_file() { printf '/etc/systemd/system/%s.service' "$1"; }
# A unit file's quoted word: systemd reads % as a specifier everywhere, and $ as a variable in ExecStart (exec_word).
systemd_word() { local text=${1//\\/\\\\}; text=${text//\"/\\\"}; printf '"%s"' "${text//%/%%}"; }
exec_word() { systemd_word "${1//\$/\$\$}"; }
systemd_services() {
  local action=$1 name=$2
  shift 2
  case $action in
    delete)
      sudo systemctl disable --now "$name" >/dev/null 2>&1 || true
      sudo rm -f "$(unit_file "$name")"
      sudo systemctl daemon-reload ;;
    create)
      local cmd= args= env= dir= needs= argument pair arguments pairs
      while [ $# -gt 0 ]; do
        case $1 in
          --cmd) cmd=$2; shift 2 ;; --args) args=$2; shift 2 ;; --env) env=$2; shift 2 ;; --dir) dir=$2; shift 2 ;;
          --needs) needs=$2; shift 2 ;; --http-port) shift 2 ;; --no-stream) shift ;; *) fail "unknown service option $1" ;;
        esac
      done
      {
        printf '[Unit]\nDescription=Ouro %s\nAfter=network-online.target%s\nWants=network-online.target\n' "$name" "${needs:+ $needs.service}"
        if [ -n "$needs" ]; then printf 'Requires=%s.service\n' "$needs"; fi
        printf '\n[Service]\nUser=%s\nWorkingDirectory=%s\nExecStart=%s' "$(id -un)" "${dir//%/%%}" "$(exec_word "$cmd")"
        IFS=, read -ra arguments <<< "$args"
        for argument in "${arguments[@]}"; do printf ' %s' "$(exec_word "$argument")"; done
        printf '\n'
        IFS=, read -ra pairs <<< "$env"
        for pair in "${pairs[@]}"; do printf 'Environment=%s\n' "$(systemd_word "$pair")"; done
        printf 'Restart=always\nRestartSec=2\n\n[Install]\nWantedBy=multi-user.target\n'
      } | sudo tee "$(unit_file "$name").partial" >/dev/null
      sudo mv "$(unit_file "$name").partial" "$(unit_file "$name")"
      sudo systemctl daemon-reload
      sudo systemctl enable --now "$name" >/dev/null 2>&1 || fail "systemctl couldn't start $name; see: journalctl -u $name" ;;
  esac
}
systemd_service_exists() { [ -e "$(unit_file "$1")" ]; }

# launchd: a launch agent of this user's, which runs while they're logged in and starts again when they log in.
# Out of both domains, whichever has it: an earlier install may have put it in user/<uid>. "Not loaded" is no error.
launchd_bootout_everywhere() { # <label>
  local domain
  for domain in "$(launchd_gui_domain)" "user/$(id -u)"; do
    launchctl bootout "$domain/$1" >/dev/null 2>&1 || true
    # bootout returns before the job is gone; bootstrapping the same label meanwhile fails.
    for _ in $(seq 1 100); do launchctl print "$domain/$1" >/dev/null 2>&1 || break; sleep 0.1; done
  done
}
# launchd has no dependencies, so `--needs` is dropped (the guardian waits for the host's socket itself, and launchd
# restarts whichever exits).
launchd_label() { printf 'com.ouro.%s' "$1"; }
plist_file() { printf '%s/Library/LaunchAgents/%s.plist' "$HOME" "$(launchd_label "$1")"; }
# Quoted replacements: bash 5.2 reads a bare & in one as the matched text.
xml() { local text=${1//&/"&amp;"}; text=${text//</"&lt;"}; printf '%s' "${text//>/"&gt;"}"; }
launchd_services() {
  local action=$1 name=$2 label
  label=$(launchd_label "$name")
  shift 2
  case $action in
    delete)
      launchd_bootout_everywhere "$label"
      rm -f "$(plist_file "$name")" ;;
    create)
      local cmd= args= env= dir= argument pair more pairs error
      while [ $# -gt 0 ]; do
        case $1 in
          --cmd) cmd=$2; shift 2 ;; --args) args=$2; shift 2 ;; --env) env=$2; shift 2 ;; --dir) dir=$2; shift 2 ;;
          --needs|--http-port) shift 2 ;; --no-stream) shift ;; *) fail "unknown service option $1" ;;
        esac
      done
      local arguments=()
      if [ "${OURO_NEXT_KEEP_AWAKE:-off}" = on ] && [ "$name" = "$host_service" ]; then arguments+=(/usr/bin/caffeinate -i); fi
      arguments+=("$cmd")
      IFS=, read -ra more <<< "$args"
      arguments+=("${more[@]}")
      mkdir -p "$HOME/Library/LaunchAgents" "$root/logs"
      {
        printf '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n'
        printf '<plist version="1.0">\n<dict>\n\t<key>Label</key><string>%s</string>\n\t<key>ProgramArguments</key>\n\t<array>\n' "$label"
        for argument in "${arguments[@]}"; do printf '\t\t<string>%s</string>\n' "$(xml "$argument")"; done
        printf '\t</array>\n\t<key>EnvironmentVariables</key>\n\t<dict>\n'
        IFS=, read -ra pairs <<< "$env"
        for pair in "${pairs[@]}"; do printf '\t\t<key>%s</key><string>%s</string>\n' "$(xml "${pair%%=*}")" "$(xml "${pair#*=}")"; done
        printf '\t</dict>\n\t<key>WorkingDirectory</key><string>%s</string>\n' "$(xml "$dir")"
        printf '\t<key>RunAtLoad</key><true/>\n\t<key>KeepAlive</key><true/>\n\t<key>ThrottleInterval</key><integer>2</integer>\n'
        printf '\t<key>ProcessType</key><string>Interactive</string>\n\t<key>LimitLoadToSessionType</key><string>Aqua</string>\n'
        printf '\t<key>StandardOutPath</key><string>%s</string>\n\t<key>StandardErrorPath</key><string>%s</string>\n' \
          "$(xml "$root/logs/$name.log")" "$(xml "$root/logs/$name.log")"
        printf '</dict>\n</plist>\n'
      } > "$(plist_file "$name").partial"
      mv "$(plist_file "$name").partial" "$(plist_file "$name")"
      launchd_bootout_everywhere "$label"
      error=$(launchctl bootstrap "$launchd_domain" "$(plist_file "$name")" 2>&1) ||
        fail "launchctl couldn't start $name: ${error:-no reason given}. Its own log: $root/logs/$name.log" ;;
  esac
}
launchd_service_exists() { [ -e "$(plist_file "$1")" ]; }

case $service_manager in
  sprite) services() { sprite_services "$@"; }; service_exists() { sprite_service_exists "$@"; } ;;
  systemd) services() { systemd_services "$@"; }; service_exists() { systemd_service_exists "$@"; } ;;
  launchd) services() { launchd_services "$@"; }; service_exists() { launchd_service_exists "$@"; } ;;
esac
service_current() { service_exists "$1" && [ "$(cat "$state_dir/$1.definition" 2>/dev/null)" = "$2" ]; }
ensure_service() {
  local name=$1 definition=$2
  shift 2
  service_current "$name" "$definition" && return
  if service_exists "$name"; then
    say "replacing service $name"
    services delete "$name"
  else
    say "creating service $name"
  fi
  services create "$name" "$@" --no-stream
  echo "$definition" > "$state_dir/$name.definition"
}
host_definition="$host_copy $service_env"
# Only on a Mac, so other machines' definitions, and their runners, stay as they are.
# Launch agents limited to the login session: a Mac installed before gets its plists rewritten once.
if [ "$service_manager" = launchd ]; then host_definition+=" keep-awake=${OURO_NEXT_KEEP_AWAKE:-off} session=Aqua"; fi
# The guardian needs the host, so its service manager won't stop the host under it: a new host means a new guardian too.
if service_exists "$host_service" && ! service_current "$host_service" "$host_definition" && service_exists "$guardian_service"; then
  say "stopping $guardian_service to replace the runner host; runners end and agents resume their conversations"
  services delete "$guardian_service"
fi
ensure_service "$host_service" "$host_definition" \
  --cmd "$node_bin" --args "--no-warnings,$host_copy/runner-host.ts,$host_socket,$home_dir/releases" --env "$service_env" --dir "$root"
guardian_args=(--cmd "$node_bin" --args "--no-warnings,$guardian_copy/src/main.ts,$config" --env "$service_env" --dir "$root" --needs "$host_service")
if [ -n "$http_port" ]; then guardian_args+=(--http-port "$http_port"); fi
guardian_definition="$guardian_copy $config_hash $http_port $service_env"
if [ "$service_manager" = launchd ]; then guardian_definition+=" session=Aqua"; fi
ensure_service "$guardian_service" "$guardian_definition" "${guardian_args[@]}"

# 6. The release: the first one is built when the guardian first starts; after that, deploy the commit if it isn't live.
guardian_status() {
  SOCKET=$home_dir/guardian.sock "$node_bin" -e '
    const request = require("node:http").request({ socketPath: process.env.SOCKET, path: "/status" }, (response) => {
      let body = ""; response.on("data", (chunk) => body += chunk); response.on("end", () => process.stdout.write(body))
    })
    request.on("error", () => process.exit(1)); request.end()' 2>/dev/null
}
field() { "$node_bin" -e 'const value = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(value === null ? "" : String(value))' "$1" "$2"; }
# How long the guardian may take to answer on its socket once its service starts.
GUARDIAN_ANSWER_WAIT_S=120
# How long the first build, its checks, acceptance and steady window may take.
RELEASE_WAIT_S=900
# Sets `status` to the guardian's first answer.
wait_for_guardian() {
  status=
  for _ in $(seq 1 "$GUARDIAN_ANSWER_WAIT_S"); do status=$(guardian_status) && break; sleep 1; done
  [ -n "$status" ] || fail "the guardian didn't answer on $home_dir/guardian.sock; see $home_dir/guardian/ourod.log and the $guardian_service service"
}
# Nothing live and nothing building: the guardian builds once, when it starts, and that build failed.
nothing_live_or_building() { [ -z "$(field "$1" active)" ] && [ "$(field "$1" deploying)" = false ]; }

say "waiting for the guardian"
wait_for_guardian
# If the build failed before (an earlier run of this script, say), start the guardian over to build again, once.
if nothing_live_or_building "$status"; then
  say "no release is live or building; restarting $guardian_service to build one"
  services delete "$guardian_service"
  rm -f "$state_dir/$guardian_service.definition"
  ensure_service "$guardian_service" "$guardian_definition" "${guardian_args[@]}"
  wait_for_guardian
fi
say "waiting for a live release (the first build, checks, acceptance and steady window take a few minutes)"
for _ in $(seq 1 "$RELEASE_WAIT_S"); do
  status=$(guardian_status) || status='{}'
  if [ -n "$(field "$status" active)" ] && [ "$(field "$status" deploying)" = false ]; then break; fi
  # Its build has ended without a release: waiting longer wouldn't change that.
  if [ "$status" != '{}' ] && nothing_live_or_building "$status"; then
    fail "the guardian's build failed and nothing is live; see $home_dir/guardian/deployments.jsonl and $home_dir/guardian/ourod.log"
  fi
  sleep 1
done
active=$(field "$status" active)
[ -n "$active" ] || fail "no release went live within $RELEASE_WAIT_S seconds; see $home_dir/guardian/deployments.jsonl"
export OURO_SOCKET=$home_dir/data/local.sock OURO_GUARDIAN_SOCKET=$home_dir/guardian.sock
if [ "${active%"${commit:0:8}"}" = "$active" ]; then
  say "deploying $commit (live: $active)"
  "$home_dir/bin/ouro" deploy "$commit"
fi

# 7. Proof it answers, locally and at the public URL, then a way in for a phone.
say "live: $(field "$(guardian_status)" active)"
# The update check answers anyone: 204 (no update yet) or 200 means the server is reachable there.
update_check() { curl -s -o /dev/null -w '%{http_code}' -H 'expo-platform: ios' -H 'expo-runtime-version: install-check' "$1/updates/manifest" || echo unreachable; }
printf 'local  update check: HTTP %s\n' "$(update_check "http://127.0.0.1:$listen_port")"
printf 'public update check: HTTP %s (%s)\n' "$(update_check "$public_url")" "$public_url"
command -v claude >/dev/null || say "note: claude isn't on PATH here, so agents on a Claude model can't start until it is installed and signed in"
"$home_dir/bin/ouro" pair
