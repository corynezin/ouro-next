# Phone UI flows

Maestro flows run on the `ouro-rebirth-sim` simulator against a real local `ourod` on the stand-in model. Set `OURO_SIM`
(such as `ouro-rebirth-sim-2`) and `OURO_MAESTRO_PORT` to run a second simulator at once; only one native build runs at a
time, so the second simulator installs the last one (no `--native`).

```sh
scripts/maestro-m1.sh            # installs this checkout's JS into the last simulator build, then runs m1/
scripts/maestro-m1.sh --native   # rebuilds the native app first
```

Maestro and a JDK live in `.tools/` (git-ignored), never globally: `.tools/maestro` (Maestro CLI) and `.tools/jdk`
(JDK 21). Screenshots go to `.tools/maestro-out` and are never committed.

Flows 03a, 03 and 04 rely on the runner killing and restarting the server between them, so run them through the script.
Long strings are not typed: simulator typing garbles them, so pairing opens the link instead.

`m2/update-banner-tap.yaml` checks the update banner: publish an update on the home server, then run it on its own.

`scripts/maestro-parity.sh` runs `parity/` after the M1 pair and new-agent flows on a fresh install. These flows are the
evidence for rows ticked in `docs/parity.md`; each names the row IDs it covers.

## P0 phone suite

`scripts/maestro-p0.sh` runs the product brief's "Phone UI" tier in one command: pairing (1), chat (2), failed send and
retry (3a-3c, with the server killed and restarted between them), asks (4) and the update banner (5, which publishes a
labelled commit to the local test server). Flows live in `apps/mobile/maestro/p0` and wrap the m1/m2/parity flows.
Onboarding (Welcome and Setup) joins once it is on main. Run it on its own; the full suite is left to CI.

Last recorded result (2026-11-10, simulator `ouro-rebirth-sim-2`, stand-in model): five full runs in a row passed, including
step 5 with the hardened update restart (#140), on main at 559c163. Four were under light CPU load (one busy process),
the fifth on an idle machine. An earlier run failed in flow 2 when Maestro's iOS driver stopped mid-step; it was my own
interference with the simulator, not a flow result. A fresh install opens on Welcome, so flow 1 taps "I have my own
server: pair with a code" before it asserts the pair form.
