#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a Mac: what it needs (Node, git, tmux, gh, jq, a current bash,
# Claude Code) from Homebrew, then the server itself as this user's launch agents through install-run.sh. Other
# computers and phones reach it over Tailscale, so the Mac needs the Tailscale app, signed in to the person's tailnet.
# The services run while the person is logged in to the Mac, and start again when they log in; so run it while they are
# logged in (from a Terminal there, or over SSH meanwhile). Running it again changes only what differs.
#
#   scripts/install-run-mac.sh [<commit>]
#
# It installs <root>/source, cloning it when it isn't there yet: from OURO_NEXT_REPO, or else from where the copy this
# script was run from came from. With no commit it installs the source's current commit (on a fresh clone, its main).
#
# Optional settings, as environment variables (and install-run.sh's own):
#   OURO_NEXT_ROOT          where everything lives (default ~/ouro)
#   OURO_NEXT_REPO          what to clone when <root>/source doesn't exist yet: a git URL, or a git bundle's path. A
#                           GitHub URL signs in with gh first, so a private repository works.
#   OURO_NEXT_PUBLIC_URL    where phones and other computers reach this Mac (default http://<its Tailscale IP>:<the
#                           listen port, OURO_NEXT_LISTEN_PORT, 8080 by default>)
#   OURO_NEXT_MACHINE_NAME  this computer's name (default: the Mac's local host name, lower case)
#   OURO_NEXT_KEEP_AWAKE    on: the Mac doesn't sleep when idle while Ouro runs, so agents keep working; closing a laptop's
#                           lid still sleeps it (default on)
#   OURO_NEXT_JOIN          the command `ouro computers invite` printed on another of the person's computers (or just
#                           its address and code): join that computer once the server is live
#
# The guardian listens on every interface, unlike on Ubuntu, where Caddy is in front on the same machine: here phones and
# computers reach the guardian's port itself, at the Mac's Tailscale address, and binding only that address would fail
# whenever the guardian starts before Tailscale is up (at login, say). The macOS firewall, if on, guards the local network.
# Runs with the bash macOS ships (3.2) until Homebrew's is there.
set -euo pipefail

install_name=install-run-mac
script_dir=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib/install-common.sh
. "$script_dir/lib/install-common.sh"

[ "$(uname -s)" = Darwin ] || fail "this script is for macOS"
[ "$(id -u)" -ne 0 ] || fail "run this as the person who uses this Mac, not root"
root=${OURO_NEXT_ROOT:-$ouro_default_root}
source_dir=$root/source

# 1. What the server and its agents need.
if ! command -v brew >/dev/null; then
  for brew in /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$brew" ] && eval "$("$brew" shellenv)" && break; done
fi
command -v brew >/dev/null || fail 'Homebrew is needed. Install it, then run this again:
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"'
export HOMEBREW_NO_AUTO_UPDATE=1 HOMEBREW_NO_INSTALL_CLEANUP=1 HOMEBREW_NO_ENV_HINTS=1
brew_bin=$(brew --prefix)/bin
missing=()
for formula in git tmux gh jq; do command -v $formula >/dev/null || missing+=($formula); done
[ -x "$brew_bin/bash" ] || missing+=(bash)
has_node_needed || missing+=(node)
if [ ${#missing[@]} -gt 0 ]; then
  say "installing ${missing[*]}"
  brew install --quiet "${missing[@]}" >/dev/null
fi
hash -r
require_node_needed node "put Homebrew's first on PATH"
install_claude_code

# 2. How other computers and phones reach it: Tailscale.
public_url=${OURO_NEXT_PUBLIC_URL:-}
if [ -z "$public_url" ]; then
  tailscale=$(command -v tailscale || true)
  [ -n "$tailscale" ] || [ ! -x /Applications/Tailscale.app/Contents/MacOS/Tailscale ] || tailscale=/Applications/Tailscale.app/Contents/MacOS/Tailscale
  [ -n "$tailscale" ] || fail "Tailscale isn't installed. Install the Tailscale app (https://tailscale.com/download/mac), sign in to the same tailnet as your other computers, then run this again; or set OURO_NEXT_PUBLIC_URL"
  ip=$("$tailscale" ip -4 2>/dev/null | head -1 || true)
  is_ipv4 "$ip" || fail "Tailscale isn't connected. Open the Tailscale app and sign in, then run this again"
  public_url=http://$ip:$ouro_listen_port
fi
say "reached at $public_url"

# 3. The person's copy of the source. GitHub needs signing in when the repository is private.
# Run from a checkout elsewhere, clone what that checkout came from.
here=$(git -C "$script_dir" rev-parse --show-toplevel 2>/dev/null || true)
repo=${OURO_NEXT_REPO:-$( [ -z "$here" ] || git -C "$here" remote get-url origin 2>/dev/null || true)}
origin=$repo
[ ! -d "$source_dir/.git" ] || origin=$(git -C "$source_dir" remote get-url origin 2>/dev/null || true)
if [[ $origin == *github.com* ]]; then
  gh auth status -h github.com >/dev/null 2>&1 || { say "signing in to GitHub"; gh auth login -h github.com -p https -w; }
  gh auth setup-git -h github.com
fi
if [ ! -d "$source_dir/.git" ]; then
  [ -n "$repo" ] || fail "no copy of the source at $source_dir. Clone yours there and run this again:
  gh repo clone <you>/<your copy> $source_dir && $source_dir/scripts/install-run-mac.sh
or set OURO_NEXT_REPO to what to clone"
  say "cloning $repo"
  mkdir -p "$root"
  git clone --quiet "$repo" "$source_dir"
fi
commit=${1:-$(git -C "$source_dir" rev-parse HEAD)}

# 4. The server, run by launchd with Homebrew's bash (macOS's own is too old): this script's own install-run.sh, so the
#    two always agree, whatever <root>/source is at.
machine_name=${OURO_NEXT_MACHINE_NAME:-$(scutil --get LocalHostName 2>/dev/null || hostname -s)}
machine_name=$(printf '%s' "$machine_name" | tr '[:upper:]' '[:lower:]')
if [ "${OURO_NEXT_KEEP_AWAKE:-on}" = on ]; then say "keeping the Mac awake while Ouro runs (closing the lid still sleeps it)"; fi
OURO_NEXT_SERVICES=launchd \
OURO_NEXT_ROOT=$root \
OURO_NEXT_PUBLIC_URL=$public_url \
OURO_NEXT_KEEP_AWAKE=${OURO_NEXT_KEEP_AWAKE:-on} \
OURO_NEXT_MACHINE_NAME=$machine_name \
  "$brew_bin/bash" "$script_dir/install-run.sh" "$commit"

# 5. The firewall, which would keep other computers out.
firewall=/usr/libexec/ApplicationFirewall/socketfilterfw
if [ -x "$firewall" ] && "$firewall" --getglobalstate 2>/dev/null | grep -q enabled; then
  say "note: the macOS firewall is on. If your other computers can't reach this Mac, let node take connections:"
  printf '  sudo %s --add %s && sudo %s --unblockapp %s\n' "$firewall" "$(command -v node)" "$firewall" "$(command -v node)"
fi
# 6. `ouro` on PATH, in Homebrew's bin, talking to this server unless told otherwise (agents' own `ouro` is first on their
#    PATH and says which server it talks to).
cli=$brew_bin/ouro
wrapper=$(printf '#!/bin/sh\n# Made by install-run-mac.sh: the Ouro on this Mac.\nexport OURO_SOCKET="${OURO_SOCKET:-%s}"\nexec "%s" "$@"\n' \
  "$root/home/data/local.sock" "$root/home/bin/ouro")
if [ -e "$cli" ] && ! grep -q 'install-run-mac.sh' "$cli"; then
  say "note: $cli isn't this installer's, so it stays; use $root/home/bin/ouro with OURO_SOCKET=$root/home/data/local.sock"
  cli=$root/home/bin/ouro
elif [ "$(cat "$cli" 2>/dev/null)" != "$wrapper" ]; then
  printf '%s\n' "$wrapper" > "$cli.partial" && chmod 755 "$cli.partial" && mv "$cli.partial" "$cli"
  say "\`ouro\` is on your PATH"
fi
export OURO_SOCKET=$root/home/data/local.sock
# 7. Joining the person's other computers: the invite, as an address and a code, or as the whole command `ouro computers
#    invite` printed. The code is a secret, so only the address is shown. An invite works once, so on a re-run with the
#    same one still set, the join fails after a good install: that is said, and doesn't fail the install.
join=${OURO_NEXT_JOIN:-}
join=${join#ouro computers join }
if [ -n "$join" ]; then
  say "joining the computer at ${join%% *}"
  # shellcheck disable=SC2086 # the address and the code, as two arguments
  "$cli" computers join $join ||
    say "note: joining didn't work. If this Mac joined already, unset OURO_NEXT_JOIN; otherwise run \`ouro computers invite\` there again and paste the new command here"
else
  say "to join your other computers, run \`ouro computers invite\` on one of them, then paste the command it prints here"
fi
