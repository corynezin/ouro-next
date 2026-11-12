#!/usr/bin/env bash
# Installs, or moves to another commit, the server on a run Sprite: install-run.sh with the Sprite's own service manager
# (sprite-env) and URL. A Sprite keeps the root (~/ouro-next) and service names (ouro-next-…) Sprites have always had, so
# one set up before keeps its services.
#
#   scripts/install-run-sprite.sh <commit>
#
# Settings: install-run.sh's own, with these defaults here:
#   OURO_NEXT_PUBLIC_URL      https://ouro-next-run-b5wj7.sprites.app
#   OURO_NEXT_ROOT            ~/ouro-next
#   OURO_NEXT_SERVICE_PREFIX  ouro-next
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export OURO_NEXT_SERVICES=sprite
export OURO_NEXT_PUBLIC_URL=${OURO_NEXT_PUBLIC_URL:-https://ouro-next-run-b5wj7.sprites.app}
export OURO_NEXT_ROOT=${OURO_NEXT_ROOT:-$HOME/ouro-next}
export OURO_NEXT_SERVICE_PREFIX=${OURO_NEXT_SERVICE_PREFIX:-ouro-next}
exec bash "$here/install-run.sh" "$@"
