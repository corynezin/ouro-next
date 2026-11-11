#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a plain Ubuntu machine, such as an EC2 instance: what it needs
# (Node, git, tmux, gh, Claude Code, Caddy), HTTPS in front of the server, then the server itself as systemd services
# through install-run-sprite.sh. Run it as the user Ouro runs as (on EC2, `ubuntu`), who needs sudo without a password.
# Running it again changes only what differs.
#
#   scripts/install-run-ubuntu.sh <commit>
#
# Optional settings, as environment variables (and install-run-sprite.sh's own):
#   OURO_NEXT_ROOT         where everything lives (default ~/ouro)
#   OURO_NEXT_PUBLIC_HOST  the name phones and other computers reach this machine by, which must point at it, with ports
#                          80 and 443 open to the internet (default: <its public IP, dashed>.sslip.io, a name that
#                          points at that IP). Caddy gets its certificate from Let's Encrypt.
#   OURO_NEXT_REPO         what to clone when <root>/source doesn't exist yet: a git URL, or a git bundle's path
set -euo pipefail

commit=${1:?usage: install-run-ubuntu.sh <commit>}
here=$(cd "$(dirname "$0")" && pwd)
say() { printf '==> %s\n' "$*"; }
fail() { printf 'install-run-ubuntu: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as the user Ouro runs as, not root"
sudo -n true 2>/dev/null || fail "this user needs sudo without a password"
command -v apt-get >/dev/null || fail "this script is for Ubuntu (apt-get isn't here)"
export DEBIAN_FRONTEND=noninteractive

# 1. What the server and its agents need.
apt_repo() { # <name> <key url> <source line>
  local key=/etc/apt/keyrings/$1.gpg list=/etc/apt/sources.list.d/$1.list
  [ -e "$list" ] && return
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "$2" | sudo gpg --dearmor --yes -o "$key"
  echo "$3" | sudo sed "s|@KEY@|$key|" | sudo tee "$list" >/dev/null
  apt_changed=1
}
apt_changed=0
needs_apt=0
for tool in curl gpg git tmux unzip jq; do command -v $tool >/dev/null || needs_apt=1; done
if [ $needs_apt = 1 ]; then
  say "installing base packages"
  sudo apt-get update -qq && sudo apt-get install -y -qq curl ca-certificates gnupg git tmux unzip jq >/dev/null
fi
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 24 ]; then
  apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key 'deb [signed-by=@KEY@] https://deb.nodesource.com/node_24.x nodistro main'
fi
command -v gh >/dev/null || apt_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  "deb [arch=$(dpkg --print-architecture) signed-by=@KEY@] https://cli.github.com/packages stable main"
command -v caddy >/dev/null || apt_repo caddy https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  'deb [signed-by=@KEY@] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
if [ $apt_changed = 1 ] || [ "$node_major" -lt 24 ] || ! command -v gh >/dev/null || ! command -v caddy >/dev/null; then
  say "installing node 24, gh and caddy"
  sudo apt-get update -qq && sudo apt-get install -y -qq nodejs gh caddy >/dev/null
fi
export PATH=$HOME/.local/bin:$PATH
if ! command -v claude >/dev/null; then
  say "installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null || say "note: Claude Code didn't install; agents on Claude models can't start until it does"
fi
grep -qs '.local/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"

# 2. HTTPS: Caddy answers the public name and passes everything to the guardian, on its listen port.
host=${OURO_NEXT_PUBLIC_HOST:-}
if [ -z "$host" ]; then
  token=$(curl -fsS -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
  ip=$(curl -fsS -m 2 ${token:+-H "X-aws-ec2-metadata-token: $token"} http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(curl -fsS -m 5 https://checkip.amazonaws.com | tr -d '[:space:]')
  [[ $ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "couldn't find this machine's public IP; set OURO_NEXT_PUBLIC_HOST"
  host=${ip//./-}.sslip.io
fi
caddyfile=$(printf '%s {\n\treverse_proxy 127.0.0.1:%s {\n\t\tflush_interval -1\n\t}\n}\n' "$host" "${OURO_NEXT_LISTEN_PORT:-8080}")
if [ "$(cat /etc/caddy/Caddyfile 2>/dev/null)" != "$caddyfile" ]; then
  say "caddy: https://$host"
  printf '%s' "$caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl enable caddy >/dev/null 2>&1
  sudo systemctl reload-or-restart caddy
fi

# 3. The server.
export OURO_NEXT_SERVICES=systemd
export OURO_NEXT_ROOT=${OURO_NEXT_ROOT:-$HOME/ouro}
export OURO_NEXT_PUBLIC_URL=https://$host
export OURO_NEXT_HTTP_PORT=
exec "$here/install-run-sprite.sh" "$commit"
