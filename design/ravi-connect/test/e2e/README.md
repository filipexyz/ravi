# ravi-connect end-to-end test

Runs the bundle's real `assets/connect.js` in Chromium and the real `scripts/pair.ts` under Bun against two processes of the real Ravi gateway code, each with its own isolated state.

## Run

```sh
RAVI_SRC=/path/to/ravi-checkout ./run-e2e.sh      # the checkout needs `bun install` done
```

- Needs `bun`, `node` and Playwright for node with its Chromium (`npx playwright install chromium`).
- `RAVI_SRC`: a Ravi source checkout with dependencies. Default: the repository this folder is in (four levels up).
- `RAVI_CONNECT_SKILL`: the skill folder under test. Default: `../../skill/connect-installations`.
- State, homes, key files and browser profiles go in a new `ravi-connect-e2e-*` folder under the system temp dir (`TMPDIR`). The folder is deleted at the end, including after a crash. Set `E2E_KEEP=1` to keep it.
- Ports are free loopback ports, picked at random. Set `PORT_A` and `PORT_B` to fix them.
- Every Ravi process runs with its working directory set to `$RAVI_SRC`, an isolated `RAVI_STATE_DIR`, `NATS_URL=nats://127.0.0.1:1`, `RAVI_SUPPRESS_AUDIT_EVENTS=1` and `bun --no-env-file`, with no proxy variables set. It never reads or writes `~/.ravi`.
- Result: `e2e-result.json` (pass count, every case with its evidence, and notes). Keys are masked. Exit 0 only if every case passes.

## What it does

- Gateway A (`local`) and gateway B (`vps1`): `gateway2.ts` serves the real `context`, `sessions` and `agents` commands on loopback TCP. Each has an admin context bound to agent `bootstrap`, three agents and three sessions.
- The helper reaches `local` over HTTP and `vps1` through `bin-local/ssh`. Behind that stand-in, the remote side is real:
  - ssh modes (file `ssh-mode`): `hang`, `hang-after` (remote command ran, answer never arrives) and `hold` (ssh exits 0 while a background child keeps stdout open);
  - the remote shell is clean (`env -i`, `PATH=/usr/bin:/bin`), so the helper's PATH prefix is needed;
  - the remote HOME has `bun` in `~/.bun/bin`;
  - `ravi` in `~/.local/bin` is a wrapper that runs the real CLI entrypoint (`bun src/cli/index.ts`) against gateway B through `RAVI_GATEWAY_URL`.
- When the owner runs a revoke by hand, the test runs the real CLI with the admin key in the environment.
- The page is served at `https://exemplo-painel.ravi.page` with the ravi.page CSP. The test grants the local-network permission.
- Cases:
  - S, T and F: setup, linking, scope, attacks on the page, the helper and the config.
  - B: stage B.
  - X: list, ledger and race.
  - N: changes since round 1. PATH prefix and ConnectTimeout; hanging VPS and SSH_TIMEOUT; helper killed mid-approve; noisy CLI output; shortened link; default `manual` revoke; issuer without `read:context:info`; revoker key over HTTP and the CLI.
  - R: round-2 fixes. Accented phrase; disconnect --install with an unknown name; --out-dir checked before anything is used; symlink at the old temp name; status --probe (extra issuer caps, CORS, tunnel, issuer id); scope name with `rctx_`; ssh that exits while a child holds stdout; two tabs; forged envelope then the real one; forget() kills handles.
  - P: the envelope draft survives a redraw.
  - O: the owner's whole flow in one persistent profile.

## Not covered

- Real `ssh`/`sshd`, `ssh_config` and the autossh tunnel. The page talks to gateway B's port directly.
- An installed, bundled `ravi` and the real wrapper's own PATH and `.env` handling.
- The daemon and its unix socket: the CLI uses HTTP through `RAVI_GATEWAY_URL`.
- NATS: `sessions send` stops at the publish step.
- Normal Chrome and its local-network prompt. Safari and mobile.
- Real `ravi pages ship`, the private `/_link/` route and Console auth. Playwright routes stand in for them.
- The agent's chat behaviour (WhatsApp/Slack, refusing groups, typing the phrase).
- Real data, approval policies and multi-day expiry (expiry is checked through `expiresAt` only).
