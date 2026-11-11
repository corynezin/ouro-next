#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a run Sprite: the person's copy of the source, then two services.
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

node_bin=$(command -v node) || fail "node isn't installed"
"$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail "node 24 or later is needed, found $("$node_bin" --version)"
command -v git >/dev/null || fail "git isn't installed"
command -v npm >/dev/null || fail "npm isn't installed"
command -v "$sprite_env" >/dev/null || fail "$sprite_env isn't here: this script installs Sprite services"
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
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$commit" ]; then
  [ -z "$(git -C "$source_dir" status --porcelain)" ] || fail "$source_dir has uncommitted changes; commit or remove them first"
  say "source to $commit"
  git -C "$source_dir" checkout --quiet -B main "$commit"
fi

# 2. Dependencies, which releases copy from the source.
lock_hash=$(sha256sum "$source_dir/package-lock.json" | cut -d' ' -f1)
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
    MACHINE=$(hostname) "$node_bin" -e '
      const env = process.env
      const ourodEnv = { OURO_RUNNER_HOST_SOCKET: env.SOCKET, OURO_TAILSCALE: "sprite" }
      if (env.MODEL) ourodEnv.OURO_DEFAULT_MODEL = env.MODEL
      if (env.BASE_REPO) ourodEnv.OURO_BASE_REPO = env.BASE_REPO
      if (env.APNS_KEY_FILE) Object.assign(ourodEnv, { OURO_APNS_KEY_FILE: env.APNS_KEY_FILE, OURO_APNS_KEY_ID: env.APNS_KEY_ID, OURO_APNS_TEAM_ID: env.APNS_TEAM_ID })
      process.stdout.write(JSON.stringify({ home: env.ROOT_HOME, listenPort: Number(env.PORT), sourceDir: env.SOURCE, sourceBranch: "main",
        machineName: env.MACHINE, publicUrl: env.URL, ourodEnv }, null, 2) + "\n")'
)
if [ "$(cat "$config" 2>/dev/null)" != "$OURO_NEXT_CONFIG_JSON" ]; then
  say "writing $config"
  printf '%s\n' "$OURO_NEXT_CONFIG_JSON" > "$config.partial"
  mv "$config.partial" "$config"
fi
config_hash=$(sha256sum "$config" | cut -d' ' -f1)

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
service_exists() { "$sprite_env" services get "$1" >/dev/null 2>&1; }
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
[ -n "${status:-}" ] || fail "the guardian didn't answer on $home_dir/guardian.sock; see $home_dir/guardian/ourod.log and: $sprite_env services get $guardian_service"
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
