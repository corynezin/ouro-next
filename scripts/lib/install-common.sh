# What the installers share: install-run.sh, and its Sprite, Ubuntu and Mac wrappers source this; it isn't run by itself.
# Bash 3.2, which macOS ships, must read it: install-run-mac.sh sources it before Homebrew's bash is there.
# The script sourcing it sets `install_name` first, which its messages start with.

# Where everything lives, and the services' names, unless a setting or a wrapper says otherwise. A Sprite keeps the
# ~/ouro-next and ouro-next it has always had (install-run-sprite.sh), so Sprites set up before keep their services.
ouro_default_root=$HOME/ouro
ouro_default_service_prefix=ouro
# The guardian's port: the one a Sprite's URL routes to, and the one Caddy (Ubuntu) or the tailnet (a Mac) reaches.
ouro_default_listen_port=8080
ouro_listen_port=${OURO_NEXT_LISTEN_PORT:-$ouro_default_listen_port}
# The server and the guardian run TypeScript as it is, which needs Node 24's type stripping.
ouro_node_major_needed=24

say() { printf '==> %s\n' "$*"; }
fail() { printf '%s: %s\n' "${install_name:-install}" "$*" >&2; exit 1; }

is_ipv4() { [[ $1 =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; }

# The major version of the node at $1 (default: the one on PATH); 0 when there is none.
node_major() { "${1:-node}" -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
has_node_needed() { [ "$(node_major "${1:-node}")" -ge "$ouro_node_major_needed" ]; }
require_node_needed() { # [<node>] [<hint>]
  local node=${1:-node}
  command -v "$node" >/dev/null || fail "node isn't installed"
  has_node_needed "$node" ||
    fail "node $ouro_node_major_needed or later is needed, but $(command -v "$node") is $("$node" --version)${2:+; $2}"
}

# Claude Code, for agents on Claude models, from Anthropic's own installer: run as this user, never as root, into
# ~/.local/bin. Not having it doesn't stop the install; agents on Claude models wait until it is there.
install_claude_code() {
  export PATH=$HOME/.local/bin:$PATH
  command -v claude >/dev/null && return
  say "installing Claude Code"
  curl -fsSL https://claude.ai/install.sh | bash >/dev/null ||
    say "note: Claude Code didn't install; agents on Claude models can't start until it does"
}

# The public URL a server at <root> was installed with, or nothing.
installed_public_url() { # <root>
  [ -e "$1/guardian.json" ] || return 0
  "${node_bin:-node}" -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).publicUrl ?? "")' \
    "$1/guardian.json" || fail "couldn't read $1/guardian.json"
}

# Paired phones and linked computers know a server by its public URL, so a re-run doesn't quietly move it: the old name
# would go on receiving their credentials, at whatever answers it next (an EC2 address goes to someone else once the
# instance stops, unless it is an Elastic IP). Stops and says so, unless asked on purpose with OURO_NEXT_MOVE_PUBLIC_URL.
refuse_public_url_change() { # <root> <new url>
  local old
  old=$(installed_public_url "$1")
  if [ -z "$old" ] || [ "$old" = "$2" ]; then return 0; fi
  if [ "${OURO_NEXT_MOVE_PUBLIC_URL:-}" = yes ]; then
    say "moving the public URL from $old to $2: phones and computers paired with the old one need pairing again"
    return 0
  fi
  fail "this server's public URL would change from $old to $2. Phones and computers paired with it keep using the old one.
If this machine's address changed (an EC2 instance stopped and started without an Elastic IP), give it a fixed address or a
name you own, and set OURO_NEXT_PUBLIC_URL. To keep the old URL, set OURO_NEXT_PUBLIC_URL=$old. To move it on purpose,
set OURO_NEXT_MOVE_PUBLIC_URL=yes, then pair your phone and computers again."
}
