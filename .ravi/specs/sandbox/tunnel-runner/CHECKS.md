# Sandbox Gateway Tunnel Runner / CHECKS

## Suites

```bash
bun test src/gateway-expose/ src/cli/commands/gateway.test.ts src/sandbox-listener/ src/sandbox/ src/cloud-auth/ src/pm2.test.ts
bun run typecheck
bun run test:agent-contract
bun src/cli/index.ts sdk openapi check --against openapi.json
```

No check reaches the network or runs a real cloudflared: downloads, spawn,
`/config`, socket ownership, `codesign`, PM2 and `security` are fakes (the
one `lsof` run is a fake script on a private `PATH`); state lives in
`createIsolatedRaviState()`.

## Checks

- The pinned table MUST list exactly `darwin-arm64`, `darwin-amd64`,
  `linux-amd64`, `linux-arm64`, each with a 64-hex SHA-256 and a URL on the
  pinned release (`cloudflared.test.ts`, "pinned release table"); any other
  platform MUST fail with `unsupported_platform` before a download.
- A checksum mismatch MUST abort before extraction or `--version` and leave
  `~/.ravi/bin` empty; a redirect to a non-GitHub host or to `http` MUST be
  refused after one request and leave nothing; a binary that does not report
  the pinned version MUST not be installed; a good install MUST be `0700` in
  a `0700` directory, with `--version` run on the staged copy first.
- A tgz MUST yield only the regular-file member `cloudflared`; a symlink
  member or a missing one MUST be rejected.
- `locateCloudflared` MUST report the pinned install `verified: true` only
  when private to the user and matching `binarySha256`, and an explicit path
  `verified: false`.
- Supply chain (`cloudflared.test.ts`, "cloudflared supply chain"): darwin
  `binarySha256` and `CLOUDFLARE_DEVELOPER_TEAM_ID` MUST stay `null` until a
  human pins them, Linux `binarySha256` MUST equal the asset digest; on
  darwin `codesign --verify --strict -R=<Team ID requirement>` MUST run on
  the staged copy before `--version`, and a failing signature, an executable
  hash mismatch, an unpinned Team ID or an unpinned executable hash (without
  the `RAVI_CLOUDFLARED_SKIP_*` override) MUST install nothing (the
  unpinned cases before any download); reuse and `locateCloudflared` MUST
  refuse a swapped binary at the pinned path, and the unsupported-platform
  error MUST not name a `--cloudflared` flag.
- Credentials (`secret.test.ts`): the file store MUST be `0600` in a `0700`
  directory and a group-readable file MUST be refused; the Keychain store
  MUST use service `ravi.gateway-tunnel` with the secret on stdin only (no
  argv carries `TunnelSecret` or `AccountTag`); a Keychain failure MUST fall
  back to the file and leave no Keychain item; malformed objects MUST be
  rejected.
- The template (`ingress.test.ts`) MUST parse to exactly the two rules with
  Access required and `warp-routing.enabled: false`, contain no credentials,
  and not gain structure from a hostile value; args MUST bind metrics to
  `127.0.0.1` and reject an invalid port.
- `checkRemoteConfig` MUST pass the template at version -1 and flag as
  drift: version 0/3/missing, an extra rule, a repointed service, another
  hostname, a path matcher, Access not required or removed, another
  audience, a catch-all that serves or has a hostname, warp-routing on.
- Runner credentials (`tunnel-runner.test.ts`, "credentials reach
  cloudflared only through its env"): the spawn env MUST be the allowlist
  plus `TUNNEL_CRED_CONTENTS` (no `RAVI_CONTEXT_KEY`, no `TUNNEL_TOKEN`),
  argv MUST not contain the secret or account tag, `process.env` MUST be
  unchanged, no stdout/stderr line MUST contain the secret (cloudflared's
  echo is masked), and the config file MUST be `0600` without credentials.
- The runner MUST refuse with exit 78 and never spawn without credentials,
  settings or cloudflared, with an invalid metrics port, or while latched.
- End to end with a real listener (`tunnel-runner.test.ts`, "first-poll
  gate, drift ⇒ latch ⇒ listener 503 ⇒ cloudflared stopped"): before the
  first successful poll the listener MUST answer 503 `tunnel_drift`; after it,
  not; a remote config version MUST latch, SIGTERM cloudflared, exit 78, make
  the listener answer 503 `tunnel_drift`, and a restarted runner MUST refuse.
- Each of version 0, ingress change, warp-routing on, a poll error, a 2 s
  timeout, no success for 10 s, a foreign or unverifiable metrics socket
  owner MUST stop cloudflared and set the latch; a child ignoring SIGTERM
  MUST get SIGKILL; a crash inside the poller MUST stop cloudflared.
- Startup: connection failures MUST be retried within the 10 s grace without
  latching, and MUST latch when the grace runs out.
- Lifecycle: the runner MUST exit with cloudflared's code (143 for a SIGTERM
  death) and clear `last_poll_at`; MUST forward SIGTERM; MUST not spawn
  before `listener.armed` names its port; a signal while waiting MUST exit
  without spawning; a dead runner's cloudflared MUST be stopped, a reused pid
  with another name MUST not.
- A listener-port change under a running tunnel MUST stop cloudflared and
  exit 75 with no latch and the gate closed ("a gateway settings change").
- 05a review regressions (`tunnel-runner.test.ts`, "05a review
  regressions"; each fails on 29406806): a stale cloudflared MUST be waited
  for before the first poll so a crash + restart does not latch, and one
  surviving SIGKILL MUST exit 75 without spawning or latching (F-B); an
  exception after the spawn MUST stop cloudflared and `tunnel.runner` MUST
  be cleared only after it exited, and kept when it never does (F-A); a
  second runner MUST refuse with `runner_already_running` without touching
  the first one's record or gate, and a dead runner's lock MUST be replaced
  (L4); any platform but darwin MUST refuse with 78 before the lock (M3); a
  socket-owner tool failure MUST be retried after the first success and
  still end as `poll_stale`, and `defaultSocketOwners` MUST answer `{failed}`
  for a slow `lsof` and `null` only when neither tool exists (L1); a refused
  latch write MUST leave a `0600` fallback file that a restarted runner and
  a running listener honour and the latch clear removes (L2); the listener
  disarming, moving port or dying MUST stop cloudflared and exit 75 with no
  latch (L3); a wall-clock jump MUST not be drift (monotonic staleness).
- `buildPm2Env` (`pm2.test.ts`) MUST drop every `TUNNEL_*` variable.
- CLI (`gateway.test.ts`): `gateway.tunnel-run` MUST be CLI-only (no route),
  admin, hidden from help, and MUST exit 78 without settings; the PM2
  registration MUST use `ravi-gateway`, `--kill-timeout`, `--stop-exit-codes
  78`, `gateway tunnel-run`, and carry no `TUNNEL_*` or `RAVI_CONTEXT_KEY`.
