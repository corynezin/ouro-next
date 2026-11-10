# Ouro (rebirth)

A ground-up rewrite of Ouro: new server and new iPhone app, with the same features, journeys and UI.
It runs separately from the live system. Start with `docs/architecture.md`.

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
