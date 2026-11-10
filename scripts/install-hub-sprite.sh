#!/usr/bin/env bash
# Installs, or moves to another commit, the hub on its own Sprite: a copy of the source, its configuration and one
# service, `ouro-next-hub`, answering the Sprite's HTTP port. The hub makes computers as Sprites through the Sprites API.
# Running it again with the same commit and settings changes nothing; with another commit it restarts the hub there, and
# the hub carries on making any computer it was making, from the step it was at.
#
#   scripts/install-hub-sprite.sh <commit>
#
# Before the first run, the operator puts the Sprites API token in the token file (default <root>/secrets/sprites-token),
# readable only by this user (mode 600). The token never goes in the repository, the configuration, the service's
# definition or a log: the service starts a wrapper that reads the file and hands the token to the hub in its
# environment.
#
# Optional settings, as environment variables:
#   OURO_NEXT_HUB_ROOT          where everything lives (default ~/ouro-next-hub)
#   OURO_NEXT_HUB_TOKEN_FILE    the Sprites API token (default <root>/secrets/sprites-token)
#   OURO_NEXT_HUB_NAME_PREFIX   the only Sprites the hub names or touches (default ouro-next-h-)
#   OURO_NEXT_HUB_MAX_SPRITES   the most computers it makes (default 3)
#   OURO_NEXT_HUB_DEFAULT_MODEL the model new computers' agents use (default: the server's own)
#   OURO_NEXT_HUB_URL           this hub's public URL, where its computers ask for bases (default https://ouro-next-hub-b5wj7.sprites.app)
#   OURO_NEXT_HUB_BASE_REPO     the public git repository its computers take bases from, instead of this hub; empty to use the hub's
#                               (default https://github.com/corynezin/ouro-next)
#   OURO_NEXT_REPO              what to clone (default git@github.com:corynezin/ouro-rebirth.git)
#   OURO_NEXT_HUB_SERVICE       the service's name (default ouro-next-hub)
#   OURO_NEXT_HUB_PORT          the hub's port (default 8080, the port the Sprite's URL reaches)
#   OURO_NEXT_HTTP_PORT         the port the Sprite's URL routes to; empty to leave the Sprite's routing alone (default 8080)
#   OURO_NEXT_SPRITE_ENV        the Sprite's service tool (default sprite-env)
set -euo pipefail

commit_wanted=${1:?usage: install-hub-sprite.sh <commit>}
root=${OURO_NEXT_HUB_ROOT:-$HOME/ouro-next-hub}
token_file=${OURO_NEXT_HUB_TOKEN_FILE:-$root/secrets/sprites-token}
name_prefix=${OURO_NEXT_HUB_NAME_PREFIX:-ouro-next-h-}
max_sprites=${OURO_NEXT_HUB_MAX_SPRITES:-3}
repo=${OURO_NEXT_REPO:-git@github.com:corynezin/ouro-rebirth.git}
service=${OURO_NEXT_HUB_SERVICE:-ouro-next-hub}
hub_port=${OURO_NEXT_HUB_PORT:-8080}
http_port=${OURO_NEXT_HTTP_PORT-8080}
sprite_env=${OURO_NEXT_SPRITE_ENV:-sprite-env}

source_dir=$root/source
state_dir=$root/install
config=$root/hub.json
wrapper=$root/run-hub.sh

say() { printf '==> %s\n' "$*"; }
fail() { printf 'install-hub-sprite: %s\n' "$*" >&2; exit 1; }

node_bin=$(command -v node) || fail "node isn't installed"
"$node_bin" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 24 ? 0 : 1)' || fail "node 24 or later is needed, found $("$node_bin" --version)"
command -v git >/dev/null || fail "git isn't installed"
command -v npm >/dev/null || fail "npm isn't installed"
command -v "$sprite_env" >/dev/null || fail "$sprite_env isn't here: this script installs Sprite services"
[[ "$max_sprites" =~ ^[1-9][0-9]*$ ]] || fail "OURO_NEXT_HUB_MAX_SPRITES must be a whole number of at least 1, not $max_sprites"

# 0. The token: there, not empty, and readable only by this user. Its contents are never printed.
[ -f "$token_file" ] || fail "no Sprites API token at $token_file: put it there (mode 600) and run this again"
[ -s "$token_file" ] || fail "$token_file is empty"
[ "$(stat -c '%u' "$token_file")" = "$(id -u)" ] || fail "$token_file must belong to $(id -un)"
case "$(stat -c '%a' "$token_file")" in 600|400) ;; *) fail "$token_file must be readable only by $(id -un): chmod 600 $token_file" ;; esac
mkdir -p "$root" "$state_dir"

# 1. The source, at the commit. The hub hands out this checkout's main as base 0 until a base is published.
export GIT_SSH_COMMAND=${GIT_SSH_COMMAND:-ssh -o StrictHostKeyChecking=accept-new}
if [ ! -d "$source_dir/.git" ]; then
  say "cloning $repo"
  git clone --quiet "$repo" "$source_dir"
fi
git -C "$source_dir" fetch --quiet origin
commit=$(git -C "$source_dir" rev-parse --verify --quiet "$commit_wanted^{commit}") || fail "no commit $commit_wanted in $repo"
if [ "$(git -C "$source_dir" rev-parse HEAD)" != "$commit" ]; then
  [ -z "$(git -C "$source_dir" status --porcelain)" ] || fail "$source_dir has uncommitted changes; commit or remove them first"
  say "source to $commit"
  git -C "$source_dir" checkout --quiet -B main "$commit"
fi

# 2. Dependencies.
lock_hash=$(sha256sum "$source_dir/package-lock.json" | cut -d' ' -f1)
if [ ! -d "$source_dir/node_modules" ] || [ "$(cat "$state_dir/installed-lock" 2>/dev/null)" != "$lock_hash" ]; then
  say "installing dependencies"
  (cd "$source_dir" && npm ci --no-audit --no-fund --loglevel=error)
  echo "$lock_hash" > "$state_dir/installed-lock"
fi

# 3. The configuration: no token in it.
HUB_CONFIG_JSON=$(
  DIR=$root/data PORT=$hub_port SOURCE=$source_dir PREFIX=$name_prefix MAX=$max_sprites MODEL=${OURO_NEXT_HUB_DEFAULT_MODEL:-} \
    HUB_URL=${OURO_NEXT_HUB_URL:-https://ouro-next-hub-b5wj7.sprites.app} \
    BASE_REPO=${OURO_NEXT_HUB_BASE_REPO-https://github.com/corynezin/ouro-next} "$node_bin" -e '
    const env = process.env
    const provisioner = { kind: "sprites", namePrefix: env.PREFIX, maxSprites: Number(env.MAX), hubUrl: env.HUB_URL }
    if (env.MODEL) provisioner.defaultModel = env.MODEL
    if (env.BASE_REPO) provisioner.baseRepo = env.BASE_REPO
    process.stdout.write(JSON.stringify({ dir: env.DIR, port: Number(env.PORT), host: "0.0.0.0",
      distribution: { source: env.SOURCE, reference: "main" }, provisioner }, null, 2) + "\n")'
)
if [ "$(cat "$config" 2>/dev/null)" != "$HUB_CONFIG_JSON" ]; then
  say "writing $config"
  printf '%s\n' "$HUB_CONFIG_JSON" > "$config.partial"
  mv "$config.partial" "$config"
fi

# 4. The wrapper the service runs: it reads the token from its file at each start, so the token never appears in the
#    service's definition, arguments or this script's output.
wrapper_text=$(cat <<WRAPPER
#!/usr/bin/env bash
# Written by install-hub-sprite.sh. Starts the hub with the Sprites API token from its file.
set -euo pipefail
SPRITES_TOKEN=\$(cat '$token_file')
export SPRITES_TOKEN
cd '$source_dir'
exec '$node_bin' --no-warnings hub/src/main.ts serve '$config'
WRAPPER
)
if [ "$(cat "$wrapper" 2>/dev/null)" != "$wrapper_text" ]; then
  printf '%s\n' "$wrapper_text" > "$wrapper.partial"
  chmod 700 "$wrapper.partial"
  mv "$wrapper.partial" "$wrapper"
fi

# 5. The service, recreated only when the commit, the configuration or the wrapper changes.
service_path=$(printf '%s' "$PATH" | tr ':' '\n' | grep -v '\.claude-inbox' | paste -sd: -)
service_env="PATH=$service_path,HOME=$HOME"
# sprite-env reports a refusal as an error event and still exits 0.
services() {
  local output
  output=$("$sprite_env" services "$@" 2>&1) || fail "sprite-env services $1 $2 failed: $output"
  if printf '%s' "$output" | grep -q '"type":"error"'; then fail "sprite-env services $1 $2 failed: $output"; fi
}
service_exists() { "$sprite_env" services get "$1" >/dev/null 2>&1; }
definition="$commit $(sha256sum "$config" "$wrapper" | cut -d' ' -f1 | paste -sd' ') $http_port $service_env"
if ! service_exists "$service" || [ "$(cat "$state_dir/$service.definition" 2>/dev/null)" != "$definition" ]; then
  if service_exists "$service"; then
    say "replacing service $service (the hub carries on any computer it was making)"
    services delete "$service"
  else
    say "creating service $service"
  fi
  service_args=(--cmd /bin/bash --args "$wrapper" --env "$service_env" --dir "$root")
  [ -n "$http_port" ] && service_args+=(--http-port "$http_port")
  services create "$service" "${service_args[@]}" --no-stream
  echo "$definition" > "$state_dir/$service.definition"
fi

# 6. Proof it answers: the hub's base list is readable by anyone, and 204 means no base was published yet.
say "waiting for the hub"
for _ in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:$hub_port/hub/v1/bases/latest" || true)
  [ "$code" = 200 ] || [ "$code" = 204 ] && break
  sleep 1
done
[ "${code:-}" = 200 ] || [ "${code:-}" = 204 ] || fail "the hub didn't answer on port $hub_port; see: $sprite_env services get $service"
say "hub up at port $hub_port (latest base: HTTP $code), making at most $max_sprites computers named $name_prefix*"
say "an invite for the app:  (cd $source_dir && node --no-warnings hub/src/main.ts invite $config)"
