#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a run Sprite, on any Linux machine with systemd (see
# install-run-ubuntu.sh), or on a Mac with launchd (see install-run-mac.sh): the person's copy of the source, then two
# services.
# `ouro-next-host` starts runners, and `ouro-next-guardian` builds, runs and watches releases and answers the
# Sprite's HTTP port. Running it again with the same commit changes nothing; with another commit it deploys that commit.
#
#   scripts/install-run-sprite.sh <commit>
#
# Optional settings, as environment variables:
#   OURO_NEXT_ROOT           where everything lives (default ~/ouro-next)
#   OURO_NEXT_PUBLIC_URL     this Sprite's URL, used in pairing links (default https://ouro-next-run-b5wj7.sprites.app)
#   OURO_NEXT_DEFAULT_MODEL  the model new agents use (default: the server's own default)
#   OURO_NEXT_REPO           what to clone when <root>/source doesn't exist yet (required then)
#   OURO_NEXT_SERVICE_PREFIX service names (default ouro-next)
#   OURO_NEXT_LISTEN_PORT    the guardian's public port (default 8080, the port the Sprite's URL reaches)
#   OURO_NEXT_HTTP_PORT      the port the Sprite's URL routes to; empty to leave the Sprite's routing alone (default 8080)
#   OURO_NEXT_APNS_TEAM_ID   the Apple team of the APNs key (default U2Q2D6ZQP2, the app's team)
#   OURO_NEXT_BASE_REPO      a public git repository of bases, which this server takes bases from (default: none)
#   OURO_NEXT_SERVICES       what runs the services: sprite (sprite-env), systemd (system units run as this user,
#                            through sudo) or launchd (this user's launch agents, on a Mac) (default sprite)
#   OURO_NEXT_KEEP_AWAKE     on: with launchd, the Mac doesn't sleep when idle while the runner host runs (default off)
#   OURO_NEXT_MACHINE_NAME   this computer's name, to the person and its other computers (default: the hostname)
#   OURO_NEXT_PEER_ADDRESS   where the person's other computers reach this one (default: the public URL, as the server takes it)
#
# Push notifications: put the team's APNs key in <root>/apns/AuthKey_<key id>.p8 (mode 600), as Apple names it. The key
# id comes from that name; only the path reaches the server's configuration, never the key.
set -euo pipefail

commit_wanted=${1:?usage: install-run-sprite.sh <commit>}
root=${OURO_NEXT_ROOT:-$HOME/ouro-next}
public_url=${OURO_NEXT_PUBLIC_URL:-https://ouro-next-run-b5wj7.sprites.app}
repo=${OURO_NEXT_REPO:-}
prefix=${OURO_NEXT_SERVICE_PREFIX:-ouro-next}
listen_port=${OURO_NEXT_LISTEN_PORT:-8080}
http_port=${OURO_NEXT_HTTP_PORT-8080}
sprite_env=${OURO_NEXT_SPRITE_ENV:-sprite-env}
service_manager=${OURO_NEXT_SERVICES:-sprite}
peer_address=${OURO_NEXT_PEER_ADDRESS:-}

source_dir=$root/source
home_dir=$root/home
stable_dir=$root/stable
state_dir=$root/install
config=$root/guardian.json
host_service=$prefix-host
guardian_service=$prefix-guardian
host_socket=$home_dir/runner-host.sock

say() { printf '==> %s\n' "$*"; }
fail() { printf 'install-run-sprite: %s\n' "$*" >&2; exit 1; }
# macOS has shasum, not sha256sum.
sha256_of() { if command -v sha256sum >/dev/null; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

node_bin=$(command -v node) || fail "node isn't installed"
"$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail "node 24 or later is needed, found $("$node_bin" --version)"
command -v git >/dev/null || fail "git isn't installed"
command -v npm >/dev/null || fail "npm isn't installed"
case $service_manager in
  sprite) command -v "$sprite_env" >/dev/null || fail "$sprite_env isn't here: this script installs Sprite services (set OURO_NEXT_SERVICES=systemd elsewhere)" ;;
  systemd) command -v systemctl >/dev/null || fail "systemctl isn't here"; sudo -n true 2>/dev/null || fail "systemd services need sudo without a password" ;;
  launchd) command -v launchctl >/dev/null || fail "launchctl isn't here" ;;
  *) fail "OURO_NEXT_SERVICES must be sprite, systemd or launchd, not $service_manager" ;;
esac
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
  ROOT_HOME=$home_dir SOURCE=$source_dir PORT=$listen_port URL=$public_url SOCKET=$host_socket MODEL=${OURO_NEXT_DEFAULT_MODEL:-} \
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
      process.stdout.write(JSON.stringify({ home: env.ROOT_HOME, listenPort: Number(env.PORT), sourceDir: env.SOURCE, appSourceDir: env.SOURCE + "/apps/mobile", sourceBranch: "main",
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
#    Services run with this PATH, without another Ouro's command shims.
service_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '\.claude-inbox' | paste -sd: -)
service_env="PATH=$service_path,HOME=$HOME"
# sprite-env reports a refusal as an error event and still exits 0.
services() {
  local output
  output=$("$sprite_env" services "$@" 2>&1) || fail "sprite-env services $1 $2 failed: $output"
  if printf '%s' "$output" | grep -q '"type":"error"'; then fail "sprite-env services $1 $2 failed: $output"; fi
}
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
      local cmd= args= env= dir= needs=
      while [ $# -gt 0 ]; do
        case $1 in
          --cmd) cmd=$2; shift 2 ;; --args) args=$2; shift 2 ;; --env) env=$2; shift 2 ;; --dir) dir=$2; shift 2 ;;
          --needs) needs=$2; shift 2 ;; --http-port) shift 2 ;; --no-stream) shift ;; *) fail "unknown service option $1" ;;
        esac
      done
      {
        printf '[Unit]\nDescription=Ouro %s\nAfter=network-online.target%s\nWants=network-online.target\n' "$name" "${needs:+ $needs.service}"
        [ -n "$needs" ] && printf 'Requires=%s.service\n' "$needs"
        printf '\n[Service]\nUser=%s\nWorkingDirectory=%s\nExecStart=%s' "$(id -un)" "${dir//%/%%}" "$(exec_word "$cmd")"
        local argument pair
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
# launchd: a launch agent of this user's, which runs while they're logged in and starts again when they log in.
# Arguments as systemd_services takes them; launchd has no dependencies, so `--needs` is dropped (the guardian waits for
# the host's socket itself, and launchd restarts whichever exits).
launchd_domain=gui/$(id -u)
launchctl print "$launchd_domain" >/dev/null 2>&1 || launchd_domain=user/$(id -u)
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
      launchctl bootout "$launchd_domain/$label" >/dev/null 2>&1 || true
      # bootout returns before the job is gone; bootstrapping the same label meanwhile fails.
      for _ in $(seq 1 100); do launchctl print "$launchd_domain/$label" >/dev/null 2>&1 || break; sleep 0.1; done
      rm -f "$(plist_file "$name")" ;;
    create)
      local cmd= args= env= dir= argument pair
      while [ $# -gt 0 ]; do
        case $1 in
          --cmd) cmd=$2; shift 2 ;; --args) args=$2; shift 2 ;; --env) env=$2; shift 2 ;; --dir) dir=$2; shift 2 ;;
          --needs|--http-port) shift 2 ;; --no-stream) shift ;; *) fail "unknown service option $1" ;;
        esac
      done
      local arguments=()
      [ "${OURO_NEXT_KEEP_AWAKE:-off}" = on ] && [ "$name" = "$host_service" ] && arguments+=(/usr/bin/caffeinate -i)
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
        printf '\t<key>ProcessType</key><string>Interactive</string>\n'
        printf '\t<key>StandardOutPath</key><string>%s</string>\n\t<key>StandardErrorPath</key><string>%s</string>\n' \
          "$(xml "$root/logs/$name.log")" "$(xml "$root/logs/$name.log")"
        printf '</dict>\n</plist>\n'
      } > "$(plist_file "$name").partial"
      mv "$(plist_file "$name").partial" "$(plist_file "$name")"
      launchctl bootstrap "$launchd_domain" "$(plist_file "$name")" 2>/dev/null || fail "launchctl couldn't start $name; see $root/logs/$name.log" ;;
  esac
}
if [ "$service_manager" = systemd ]; then
  services() { systemd_services "$@"; }
  service_exists() { [ -e "$(unit_file "$1")" ]; }
elif [ "$service_manager" = launchd ]; then
  services() { launchd_services "$@"; }
  service_exists() { [ -e "$(plist_file "$1")" ]; }
else
service_exists() { "$sprite_env" services get "$1" >/dev/null 2>&1; }
fi
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
[ "$service_manager" = launchd ] && host_definition+=" keep-awake=${OURO_NEXT_KEEP_AWAKE:-off}"
# The guardian needs the host, so the Sprite won't stop the host under it: a new host means a new guardian too.
if service_exists "$host_service" && ! service_current "$host_service" "$host_definition" && service_exists "$guardian_service"; then
  say "stopping $guardian_service to replace the runner host; runners end and agents resume their conversations"
  services delete "$guardian_service"
fi
ensure_service "$host_service" "$host_definition" \
  --cmd "$node_bin" --args "--no-warnings,$host_copy/runner-host.ts,$host_socket,$home_dir/releases" --env "$service_env" --dir "$root"
guardian_args=(--cmd "$node_bin" --args "--no-warnings,$guardian_copy/src/main.ts,$config" --env "$service_env" --dir "$root" --needs "$host_service")
[ -n "$http_port" ] && guardian_args+=(--http-port "$http_port")
ensure_service "$guardian_service" "$guardian_copy $config_hash $http_port $service_env" "${guardian_args[@]}"

# 6. The release: the first one is built when the guardian first starts; after that, deploy the commit if it isn't live.
guardian_status() {
  SOCKET=$home_dir/guardian.sock "$node_bin" -e '
    const request = require("node:http").request({ socketPath: process.env.SOCKET, path: "/status" }, (response) => {
      let body = ""; response.on("data", (chunk) => body += chunk); response.on("end", () => process.stdout.write(body))
    })
    request.on("error", () => process.exit(1)); request.end()' 2>/dev/null
}
field() { "$node_bin" -e 'const value = JSON.parse(process.argv[1])[process.argv[2]]; process.stdout.write(value === null ? "" : String(value))' "$1" "$2"; }

say "waiting for the guardian"
for _ in $(seq 1 120); do status=$(guardian_status) && break; sleep 1; done
[ -n "${status:-}" ] || fail "the guardian didn't answer on $home_dir/guardian.sock; see $home_dir/guardian/ourod.log and the $guardian_service service"
# A guardian builds once, when it first starts. If that build failed (an earlier run of this script, say), nothing is live
# or building, so start the guardian over to build again.
if [ -z "$(field "$status" active)" ] && [ "$(field "$status" deploying)" = false ]; then
  say "no release is live or building; restarting $guardian_service to build one"
  services delete "$guardian_service"
  rm -f "$state_dir/$guardian_service.definition"
  ensure_service "$guardian_service" "$guardian_copy $config_hash $http_port $service_env" "${guardian_args[@]}"
  status=
  for _ in $(seq 1 120); do status=$(guardian_status) && break; sleep 1; done
  [ -n "${status:-}" ] || fail "the guardian didn't answer on $home_dir/guardian.sock after its restart"
fi
say "waiting for a live release (the first build, checks, acceptance and steady window take a few minutes)"
for _ in $(seq 1 900); do
  status=$(guardian_status) || true
  [ -n "$(field "$status" active)" ] && [ "$(field "$status" deploying)" = false ] && break
  sleep 1
done
active=$(field "$status" active)
[ -n "$active" ] || fail "no release went live; see $home_dir/guardian/deployments.jsonl"
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
