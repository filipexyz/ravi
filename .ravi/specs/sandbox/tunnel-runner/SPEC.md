---
id: sandbox/tunnel-runner
title: "Sandbox Gateway Tunnel Runner"
kind: capability
domain: sandbox
capabilities:
  - tunnel-runner
tags:
  - sandbox
  - gateway
  - cloudflared
  - tunnel
  - security
applies_to:
  - src/gateway-expose/**
  - src/sandbox/tunnel-state.ts
  - src/cli/commands/gateway.ts
owners:
  - rbbt-sandbox
status: active
normative: true
---

# Sandbox Gateway Tunnel Runner

## Intent

A connected sandbox reaches its home daemon through the Console Gate, a
Cloudflare tunnel and the loopback sandbox listener (`sandbox/listener`). The
tunnel is **locally managed** (`config_src: "local"`): Console creates it and
returns its credentials once; the host writes the ingress, runs cloudflared
and polices it. The tunnel runner is that host half: it installs a pinned
cloudflared, keeps the tunnel credentials out of argv, PM2 and logs, runs
cloudflared as its child, and is the drift poller that stops cloudflared and
closes the listener when the tunnel's configuration is not the host's.

The normative contract is Console's `console/sandbox-gateway/listener` SPEC
§Host And cloudflared and §Drift Check (Fail Closed, Latching), with
`console/sandbox-gateway/tunnels` §Provisioning, §Host-Pinned Reach and
§Host Configuration. When this spec and Console's disagree, Console's wins and
this one is corrected. The stack plan (§05a) predates the locally managed
tunnel and speaks of `TUNNEL_TOKEN`; this spec follows Console (WHY §Plan
items the spec superseded).

## Vocabulary

- Tunnel credentials: the cloudflared credentials-file object
  `{AccountTag, TunnelID, TunnelSecret}` Console returns at expose and rotate.
- Template: the ingress the host writes (§Configuration). Anything else
  cloudflared reports is drift.
- Tunnel gate: `tunnel.drift_latch` and `tunnel.last_poll_at` in
  `sandbox_listener_state` (ravi.db), written by the runner and read by the
  listener (`sandbox/listener` §Request checks).
- Runner: `ravi gateway tunnel-run`, the PM2 process `ravi-gateway`.

## Invariants

### Pinned cloudflared (`cloudflared.ts`)

- `CLOUDFLARED_VERSION` is pinned, with one `{url, sha256}` per supported
  platform: `darwin-arm64` and `darwin-amd64` (`.tgz`), `linux-amd64` and
  `linux-arm64` (bare binary), every hash 64 lowercase hex copied from the
  release (RUNBOOK §Pinned release). Any other platform is an
  `unsupported_platform` error naming the supported ones.
- Each platform also pins `binarySha256`, the SHA-256 of the executable
  itself: equal to `sha256` for the bare Linux binaries; for darwin it needs
  the extracted bytes, so it is `null` until a human pins it at bump time
  (RUNBOOK §Bumping the pin). `CLOUDFLARE_DEVELOPER_TEAM_ID` (Cloudflare's
  Apple Developer ID Team ID) is likewise `null` until a human reads it with
  `codesign -dv`; it is never guessed.
- Placeholders refuse, before any download or run (reuse included): an
  unpinned `binarySha256` is `binary_unpinned` unless
  `RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1`; on darwin an unpinned Team ID logs
  `codesign team id not pinned yet` and is `codesign_unpinned` unless
  `RAVI_CLOUDFLARED_SKIP_CODESIGN=1`.
- `installCloudflared` downloads into a fresh `0700` directory under
  `~/.ravi/bin/`, follows redirects by hand (at most 5), each hop `https` on
  `github.com`, `objects.githubusercontent.com` or
  `release-assets.githubusercontent.com` (else `redirect_refused`), caps the
  download at 96 MiB, compares the SHA-256 **before** extracting anything,
  extracts only the regular-file member `cloudflared` of a tgz, compares the
  executable with `binarySha256` (`binary_mismatch`), on darwin runs
  `codesign --verify --strict
  -R='anchor apple generic and certificate leaf[subject.OU] = "<TEAM_ID>"'`
  on the staged copy (`codesign_failed`), and only then runs its `--version`,
  requires `version <CLOUDFLARED_VERSION>`, and renames it to
  `~/.ravi/bin/cloudflared-<version>` mode `0700`. The work directory is
  removed on every outcome, so any failure leaves nothing installed. An
  installed binary is reused only when its bytes still equal `binarySha256`;
  otherwise it is downloaded and replaced, never run.
- `locateCloudflared` returns the pinned install as `verified: true` only
  when it is a regular file (not a symlink), owned by this uid, with no
  group/other permission bits, and its SHA-256 equals `binarySha256` (else
  `binary_mismatch`). With `binarySha256` null it is `binary_unpinned`, or,
  with `RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1`, found with `verified: false`.
  An explicit absolute executable path is accepted and always reported
  `verified: false`; a relative or missing one is refused.

### Credentials (`secret.ts`)

- Stored under the Keychain / Secret Service service `ravi.gateway-tunnel`,
  account `tunnel`, with the cloud-auth backend selection
  (`RAVI_CLOUD_AUTH_BACKEND`: `file` default, `keychain`, `libsecret`,
  `auto`), the Keychain write going through `security -i` on stdin (02a), and
  the file store `~/.ravi/gateway/tunnel/credentials.json` (`0600`, directory
  `0700`) as the default and the fallback when an optional backend refuses.
  Exactly one store holds the secret after a write.
- The cloud-auth backends take the service name from `deps.service`
  (default `ravi.cloud-auth`, unchanged for cloud auth).
- Reading refuses a file store that is not a regular file private to this
  uid, and any value that is not exactly the three fields (UUID `TunnelID`,
  32-hex `AccountTag`, base64 `TunnelSecret` of at least 32 bytes).
- No credentials file is materialised for cloudflared: the runner passes the
  JSON in `TUNNEL_CRED_CONTENTS` in **cloudflared's environment only**. The
  secret never appears in argv, in the runner's own `process.env`, in a PM2
  entry (`buildPm2Env` drops every `TUNNEL_*` variable, which cloudflared
  would read as flags), in
  the config file or in a log line (cloudflared's output is forwarded with the
  secret masked).

### Configuration (`ingress.ts`)

- The runner writes `~/.ravi/gateway/cloudflared.yml` (`0600`) on every
  start, every scalar JSON-quoted: `tunnel: <TunnelID>`; ingress exactly
  `<gateway.tunnel.hostname>` → `http://127.0.0.1:<gateway.listener.port>`
  with `originRequest.access {required: true, teamName, audTag:
  [gateway.access.aud]}` (`teamName` = first label of
  `gateway.access.teamDomain`), then `http_status:404`;
  `warp-routing.enabled: false`. No credentials in it.
- cloudflared runs as `cloudflared tunnel --no-autoupdate --grace-period 1s
  --config <file> --metrics 127.0.0.1:<metricsPort> run <TunnelID>`. The
  metrics address is always loopback; `metricsPort` is
  `gateway.tunnel.metricsPort` (default 20241, 1024..65535, never the
  listener port; otherwise the runner refuses).
- Its environment is `PATH`, `HOME`, `TMPDIR`, `LANG`, `LC_ALL`, `TZ`,
  `SSL_CERT_FILE`, `SSL_CERT_DIR` from the runner (when set) plus
  `TUNNEL_CRED_CONTENTS`; nothing else (no `RAVI_*`, no `TUNNEL_TOKEN`).

### Start order (`tunnel-runner.ts`)

The runner refuses with exit 78 and starts nothing when the drift latch is
set (the `tunnel.drift_latch` row or the fallback latch file, §Drift poll),
the listener settings are incomplete or invalid, the platform is not darwin
(`platform_unsupported:<platform>`: cloudflared's confinement is not verified
anywhere else; the check takes an injected `platform`), the metrics port is
invalid, the credentials are missing/invalid/unsafe, cloudflared is not
installed or fails `locateCloudflared`, or another runner holds the lock.
Otherwise, in order:

0. Single runner: `~/.ravi/gateway/tunnel-runner.lock` is created `O_EXCL`
   (`0600`, `{pid, token}`). A lock whose pid is alive refuses
   (`runner_already_running:<pid>`), so a hand-run `tunnel-run` beside PM2
   never touches the other runner's cloudflared, record or gate; a lock
   whose pid is dead (or that does not parse) is stale and replaced. The
   runner removes it on exit only while it still holds its token.
1. If `tunnel.runner` records another runner (necessarily dead: the lock is
   held) whose cloudflared pid is alive and named `cloudflared`, that pid is
   sent SIGTERM and the runner waits up to 3 s for it to die, then SIGKILL
   and up to 3 s more (a reused pid with another name is left alone). If it
   is still alive the runner exits 75 (`stale_cloudflared_alive`) without
   spawning or latching, and the record is kept.
2. The template is written.
3. It waits until `listener.armed` names the configured listener port and a
   live pid (the listener checks are armed before cloudflared starts). A
   signal while waiting exits 0 without starting cloudflared.
4. `tunnel.last_poll_at` is cleared, cloudflared is spawned, `tunnel.runner`
   records both pids, and the first `/config` poll runs immediately.

### Drift poll

- Every 5 s after the first success (every 0.5 s before it), with a 2 s
  timeout: the PIDs listening on `127.0.0.1:<metricsPort>` (`lsof`, else
  `ss`) must be exactly cloudflared's, then `GET
  http://127.0.0.1:<metricsPort>/config` must answer 200 with JSON equal to
  the template: `version` -1, two rules as above (hostname, service, no path,
  `access.required` true with the same `teamName` and the single `audTag`;
  catch-all without hostname or path serving `http_status:404`),
  `warp-routing.enabled` not true.
- Before each poll the runner re-reads `listener.armed`: when it is gone,
  names another port or a dead pid, cloudflared is stopped and the runner
  exits 75 (`listener_unarmed`, no latch); PM2 restarts it and it waits for
  the listener again.
- Each success writes `tunnel.last_poll_at` (wall clock, for the listener);
  the listener serves only while it is at most 10 s old. The runner's own
  staleness and grace bookkeeping uses a monotonic clock
  (`performance.now()`), so a wall-clock step is not drift.
- Drift is: any template difference or `version` ≠ -1; an unparseable body;
  a poll error, non-200 or timeout after the first success; no success within
  the last 10 s; the metrics socket owned by any other pid, or ownership that
  cannot be determined because neither `lsof` nor `ss` exists; an exception
  inside the poller. Before the first success, an unreachable or
  not-yet-listening metrics server is retried for at most 10 s, then it is
  drift. A socket-owner tool that exists but times out (3 s) or fails is a
  transient poll failure at any time: retried, bounded by the 10 s grace
  before the first success and by the 10 s staleness rule after it.
- On drift, in order: the latch is written (`tunnel.drift_latch` `{at,
  reason}`, first cause kept, `last_poll_at` deleted), so the listener
  refuses from its next gate read (≤ 1 s). When that write fails, the
  runner writes the fallback latch file `~/.ravi/gateway/tunnel-drift.latch`
  (`0600`, `{at, reason}`, first cause kept); the runner's start check and
  the listener's gate read honour it before the database (a file that does
  not parse is still a latch), and `dbClearTunnelDriftLatch` removes it with
  the row. Then cloudflared gets SIGTERM, then
  SIGKILL after 5 s; the runner exits 78. PM2 is registered with
  `--stop-exit-codes 78`, and a restarted runner refuses while latched. The
  latch survives runner, daemon and host restarts; only a successful
  rotate/re-expose clears it (`dbClearTunnelDriftLatch`, 05b).

### Signals and exit

- SIGTERM/SIGINT are forwarded to cloudflared once; the runner exits with
  cloudflared's exit code (128 + signal number when it died by a signal).
  cloudflared exiting on its own ends the runner with its code. On every
  exit after a spawn, `tunnel.last_poll_at` is cleared, closing the
  listener's gate until the next runner polls; `tunnel.runner` is cleared
  only once cloudflared has exited (if it survives SIGKILL the record is kept
  for the next runner to stop it). Any exception after the spawn (a failed
  `tunnel.runner` write included) first stops cloudflared (SIGTERM, then
  SIGKILL after 5 s) and then propagates. A stop is not a drift: no latch.
- After each successful poll the runner re-reads the listener settings; when
  `gateway.listener.port`, `gateway.tunnel.hostname`, `gateway.access.aud` or
  `gateway.access.teamDomain` changed, or the settings are gone, it stops
  cloudflared and exits 75 (not a stop code: PM2 restarts it with a fresh
  template, or it then refuses with 78). No latch. A settings read error is
  not a change. New credentials (rotate, 05b) need `pm2 restart
  ravi-gateway`.

### PM2 and CLI

- `ravi gateway tunnel-run` is `@CliOnly` (no SDK route), hidden from help,
  admin scope, `@CommandAccess` mutate/high. The `gateway` group adds an
  OpenAPI tag only.
- `startGatewayRunnerPm2` (used by `ravi gateway expose`, 05b) runs `pm2
  delete ravi-gateway` when present, then `pm2 start bun --name ravi-gateway
  --kill-timeout 8000 --stop-exit-codes 78 -- <bundle> gateway tunnel-run`
  with `buildPm2Env` (no credentials), then `pm2 save --force`.

## Out Of Scope

- `ravi gateway expose|status|unexpose|rotate`, storing the credentials from
  Console, clearing the latch on rotate, the host report (05b).
- Linux confinement of cloudflared (dedicated uid + nftables) and the macOS
  `sandbox-exec` spike: Console listener SPEC §Confinement; not implemented
  here, so the runner refuses on any platform but darwin, and `expose` on
  Linux must refuse too until it is (05b).
