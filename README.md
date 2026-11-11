# Ouro (rebirth)

A ground-up rewrite of Ouro: new server and new iPhone app, with the same features, journeys and UI.
It runs separately from the live system.

This repository is Ouro Next's main line. Bases are its releases: tags `base-<n>`, cut by the release workflow. People develop in a private copy and send changes here as pull requests.

## Running the server

No build step: Node runs the TypeScript directly. Everything a server owns is in its data directory, under `runs/`.

```sh
npm ci
OURO_DATA=$PWD/runs/dev OURO_DEFAULT_MODEL=stand-in node server/src/bin/ourod.ts
OURO_SOCKET=$PWD/runs/dev/local.sock server/bin/ouro pair   # a one-time code for a phone
```

`npm test` runs the fast checks. `npm run test:journeys` runs real processes with the stand-in model. Live model tests are
in `journeys/live/`, are paid, and run only by hand.

Only one journey process runs at a time on a machine, across every checkout: the harness takes a lock
(`$TMPDIR/ouro-rebirth-journey.lock`) when a journey file loads it, and others print who holds it and wait. A lock left
by a process that is gone is taken over.

## Installing on a Mac

`scripts/install-run-mac.sh` installs the server on a Mac as the person's launch agents: it runs while they're logged in
and starts again when they log in. It needs Homebrew, and the Tailscale app signed in to the same tailnet as the person's
other computers, which reach it there. On the Mac, with the person's copy of the source on GitHub:

```sh
brew install gh && gh auth login
gh repo clone <you>/<your copy> ~/ouro/source
~/ouro/source/scripts/install-run-mac.sh
```

It puts `ouro` on the PATH. Then join the person's other computers: run `ouro computers invite` on one of them and paste
the command it prints on the Mac. Or pass it to the installer, which joins once the server is live:
`OURO_NEXT_JOIN="ouro computers join <address> <code>" ~/ouro/source/scripts/install-run-mac.sh`. Running the installer
again updates it to the copy's current commit.

Logs are in `~/ouro/logs/`; `launchctl bootout gui/$(id -u)/com.ouro.ouro-guardian` and `…/com.ouro.ouro-host` stop it.
