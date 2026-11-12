#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a plain Ubuntu machine, such as an EC2 instance: what it needs
# (Node, git, tmux, gh, Claude Code, Caddy), HTTPS in front of the server, then the server itself as systemd services
# through install-run.sh. Run it as the user Ouro runs as (on EC2, `ubuntu`), who needs sudo without a password.
# Running it again changes only what differs.
#
#   scripts/install-run-ubuntu.sh <commit>
#
# Optional settings, as environment variables (and install-run.sh's own):
#   OURO_NEXT_ROOT         where everything lives (default ~/ouro)
#   OURO_NEXT_PUBLIC_URL   where phones and other computers reach this machine: https://<a name>, the name pointing at
#                          it, with ports 80 and 443 open to the internet. Caddy serves that name with a certificate from
#                          Let's Encrypt. Default: https://<its public IP, dashed>.sslip.io, a name that points at that IP.
#                          That default follows the IP: on EC2 give the instance an Elastic IP, or set a name you own.
#                          Otherwise a stop and start hands the old IP, and the name, to someone else, who could then
#                          receive what paired phones and linked computers send; a re-run that would change the URL stops.
#   OURO_NEXT_REPO         what to clone when <root>/source doesn't exist yet: a git URL, or a git bundle's path
#
# The guardian listens only on 127.0.0.1: everything from outside comes through Caddy, in HTTPS.
set -euo pipefail

install_name=install-run-ubuntu
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/install-common.sh
. "$here/lib/install-common.sh"

commit=${1:?usage: install-run-ubuntu.sh <commit>}
root=${OURO_NEXT_ROOT:-$ouro_default_root}

[ "$(id -u)" -ne 0 ] || fail "run this as the user Ouro runs as, not root"
sudo -n true 2>/dev/null || fail "this user needs sudo without a password"
command -v apt-get >/dev/null || fail "this script is for Ubuntu (apt-get isn't here)"
export DEBIAN_FRONTEND=noninteractive
# A freshly booted EC2 instance's own updates often hold apt's lock for its first minutes; wait for it rather than fail.
APT_LOCK_WAIT_S=300
apt_get() { sudo apt-get -o DPkg::Lock::Timeout="$APT_LOCK_WAIT_S" "$@"; }

# 1. What the server and its agents need.
apt_repo() { # <name> <key url> <source line>
  local key=/etc/apt/keyrings/$1.gpg list=/etc/apt/sources.list.d/$1.list
  [ -e "$list" ] && return
  sudo install -d -m 0755 /etc/apt/keyrings
  curl -fsSL "$2" | sudo gpg --dearmor --yes -o "$key"
  echo "$3" | sed "s|@KEY@|$key|" | sudo tee "$list" >/dev/null
  apt_changed=1
}
apt_changed=0
needs_apt=0
for tool in curl gpg git tmux unzip jq; do command -v $tool >/dev/null || needs_apt=1; done
if [ $needs_apt = 1 ]; then
  say "installing base packages"
  apt_get update -qq
  apt_get install -y -qq curl ca-certificates gnupg git tmux unzip jq >/dev/null
fi
has_node_needed || apt_repo nodesource https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
  "deb [signed-by=@KEY@] https://deb.nodesource.com/node_$ouro_node_major_needed.x nodistro main"
command -v gh >/dev/null || apt_repo github-cli https://cli.github.com/packages/githubcli-archive-keyring.gpg \
  "deb [arch=$(dpkg --print-architecture) signed-by=@KEY@] https://cli.github.com/packages stable main"
command -v caddy >/dev/null || apt_repo caddy https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
  'deb [signed-by=@KEY@] https://dl.cloudsmith.io/public/caddy/stable/deb/debian any-version main'
if [ $apt_changed = 1 ] || ! has_node_needed || ! command -v gh >/dev/null || ! command -v caddy >/dev/null; then
  say "installing node $ouro_node_major_needed, gh and caddy"
  apt_get update -qq
  apt_get install -y -qq nodejs gh caddy >/dev/null
fi
require_node_needed node
install_claude_code
grep -qs '.local/bin' "$HOME/.profile" || echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.profile"

# 2. HTTPS: Caddy answers the public name and passes everything to the guardian, on its listen port.
[ -z "${OURO_NEXT_PUBLIC_HOST:-}" ] || fail "OURO_NEXT_PUBLIC_HOST is gone: set OURO_NEXT_PUBLIC_URL=https://$OURO_NEXT_PUBLIC_HOST instead"
public_url=${OURO_NEXT_PUBLIC_URL:-}
if [ -z "$public_url" ]; then
  token=$(curl -fsS -m 2 -X PUT -H 'X-aws-ec2-metadata-token-ttl-seconds: 60' http://169.254.169.254/latest/api/token 2>/dev/null || true)
  ip=$(curl -fsS -m 2 ${token:+-H "X-aws-ec2-metadata-token: $token"} http://169.254.169.254/latest/meta-data/public-ipv4 2>/dev/null || true)
  [ -n "$ip" ] || ip=$(curl -fsS -m 5 https://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)
  is_ipv4 "$ip" || fail "couldn't find this machine's public IP; set OURO_NEXT_PUBLIC_URL to https://<a name pointing at it>"
  public_url=https://${ip//./-}.sslip.io
fi
# Caddy's site is the URL's name: https, with no port or path, since Caddy answers on 443 and passes every path.
public_url=${public_url%/}
case $public_url in
  https://*) host=${public_url#https://} ;;
  *) fail "OURO_NEXT_PUBLIC_URL must be https://<name> here, not $public_url: Caddy serves it with a certificate" ;;
esac
case $host in
  ''|*/*|*:*|*@*) fail "OURO_NEXT_PUBLIC_URL must be just https://<name>, without a port or path, not $public_url" ;;
esac
# Before Caddy moves: a re-run doesn't quietly re-point a server phones and computers know by its old name.
refuse_public_url_change "$root" "$public_url"
caddyfile=$(printf '%s {\n\treverse_proxy 127.0.0.1:%s {\n\t\tflush_interval -1\n\t}\n}\n' "$host" "$ouro_listen_port")
if [ "$(cat /etc/caddy/Caddyfile 2>/dev/null)" != "$caddyfile" ]; then
  case $public_url in
    *.sslip.io) say "caddy: $public_url (follows this machine's IP; give it an Elastic IP, or set a name you own)" ;;
    *) say "caddy: $public_url" ;;
  esac
  printf '%s' "$caddyfile" | sudo tee /etc/caddy/Caddyfile >/dev/null
  sudo systemctl enable caddy >/dev/null 2>&1
  sudo systemctl reload-or-restart caddy
fi

# 3. The server, reached only through Caddy.
export OURO_NEXT_SERVICES=systemd
export OURO_NEXT_ROOT=$root
export OURO_NEXT_PUBLIC_URL=$public_url
export OURO_NEXT_LISTEN_HOST=127.0.0.1
exec bash "$here/install-run.sh" "$commit"
