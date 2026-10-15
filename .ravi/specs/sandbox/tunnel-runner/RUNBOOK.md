# Sandbox Gateway Tunnel Runner / RUNBOOK

## Before Editing

- Read Console's `console/sandbox-gateway/listener` SPEC (§Host And
  cloudflared, §Drift Check, §Confinement) and `tunnels` SPEC; a change to
  the template, the drift rules or the credential path starts there.
- Never put the tunnel secret in argv, a log call, an error message or the
  runner's own env. `tunnel-runner.test.ts` greps stdout/stderr for it.

## Pinned release

- Version `2026.9.1` (published 2026-09-11). Source of every hash: the GitHub
  release API, `https://api.github.com/repos/cloudflare/cloudflared/releases`,
  field `assets[].digest`, read on 2026-10-13.

  | Platform | Asset | SHA-256 |
  | --- | --- | --- |
  | darwin-arm64 | `cloudflared-darwin-arm64.tgz` | `c27ab8fd0aa489449e3d201eb02f957ef460a13b613662928b1b23394bf1bcfe` |
  | darwin-amd64 | `cloudflared-darwin-amd64.tgz` | `ff0d3b51d5ff70eceef89d6b32145fee985018a2174596a5dbe405e2766e2ac4` |
  | linux-amd64 | `cloudflared-linux-amd64` | `03f1f25d1cc93b9ad6c60569d44060bc4f17ed97075760ed8cfca4b12dcd68cc` |
  | linux-arm64 | `cloudflared-linux-arm64` | `3d97437c71848bd8df68041e12436b484a661d95073ea1937f01a845ce88faa3` |

- The Linux values also equal the release notes' "SHA256 Checksums", as they
  do for every release from 2025.8.0 to 2026.10.0. The darwin `.tgz` values
  in the release notes (`9a0b19f6…5a6e` arm64, `1ea07ae7…1b75` amd64) differ
  from the served bytes, as they do for every release in that range except
  2025.10.1: a packaging artifact, not tampering, but it means the archive
  digest alone is checked against the same host that serves the bytes. That
  is why darwin adds two independent checks (below).
- Executable pins (`binarySha256`): Linux = the asset digest above (the asset
  is the binary). darwin-arm64 and darwin-amd64: **not pinned yet** (`null`);
  they need the extracted bytes, computed by a human at bump time. Until
  then a darwin install and `locateCloudflared` refuse (`binary_unpinned`)
  unless `RAVI_CLOUDFLARED_SKIP_BINARY_PIN=1`.
- Developer ID Team ID (`CLOUDFLARE_DEVELOPER_TEAM_ID`): **not pinned yet**
  (`null`). Until then a darwin install logs `codesign team id not pinned
  yet` and refuses (`codesign_unpinned`) unless
  `RAVI_CLOUDFLARED_SKIP_CODESIGN=1`. Never fill it from memory or a web
  page: read it from the binary (below).

### Bumping the pin (a human, on a Mac with the network)

1. Pick a release at least two weeks old whose Linux digests equal its
   release notes. Copy the four asset `digest` values and URLs from
   `https://api.github.com/repos/cloudflare/cloudflared/releases` into
   `CLOUDFLARED_ASSETS` and the table above; set `CLOUDFLARED_VERSION`.
2. In a fresh empty directory, download each darwin `.tgz` and check
   `shasum -a 256` equals its `digest`. Extract it (`tar -xzf`); the member
   is `cloudflared`.
3. Signature and Team ID: `codesign -dv --verbose=4 ./cloudflared` must show
   `Authority=Developer ID Application: Cloudflare, Inc. (<TEAM_ID>)`, the
   Apple root chain, and `TeamIdentifier=<TEAM_ID>`; `codesign --verify
   --strict -R='anchor apple generic and certificate leaf[subject.OU] =
   "<TEAM_ID>"' ./cloudflared` must exit 0; `spctl -a -vv -t install
   ./cloudflared` (or `-t exec`) must report `accepted` and `source=Notarized
   Developer ID`. Set `CLOUDFLARE_DEVELOPER_TEAM_ID` to that `<TEAM_ID>` (a
   change of Team ID between releases is a stop: find out why first).
4. Cross-check against the `.pkg` Cloudflare publishes for the same version
   (`cloudflared-<arch>.pkg` on the release): `spctl -a -vv -t install
   <pkg>` must report the same Team ID; `pkgutil --check-signature <pkg>`;
   `pkgutil --expand-full <pkg> out/` and compare
   `shasum -a 256 out/*/Payload/**/cloudflared` with the extracted `.tgz`
   binary. They should be byte-identical; if they differ, compare both
   `codesign -dv` outputs and do not pin until the difference is explained.
5. Pin `shasum -a 256 ./cloudflared` (per arch) as `binarySha256`, keep
   `./cloudflared --version` matching `version <X>`, update this table and
   run the CHECKS suites. Remove any `RAVI_CLOUDFLARED_SKIP_*` from the PM2
   environment once the pins are in.

## Operating

- `ravi gateway expose` (05b) installs cloudflared, stores the credentials,
  writes the settings and registers PM2 `ravi-gateway`. The listener starts
  or restarts on `ravi.config.changed` without a daemon restart.
- `pm2 logs ravi-gateway` shows the runner and cloudflared output.
  `Waiting for the daemon's sandbox listener` means the daemon is down or its
  listener is not configured (`listener.armed` missing or on another port).
- Exit 78 (`stopped` in PM2, not restarted) means the runner refused or
  latched; the log line names the reason (`drift_latched:<cause>`,
  `gateway_not_configured`, `platform_unsupported:<platform>` (only darwin
  runs the tunnel), `credentials_missing`, `cloudflared_not_installed`,
  `cloudflared_binary_mismatch` (the installed binary changed: reinstall),
  `cloudflared_binary_unpinned` (§Pinned release), `metrics_port_invalid`,
  `runner_already_running:<pid>`).
- `runner_already_running:<pid>`: another `tunnel-run` holds
  `~/.ravi/gateway/tunnel-runner.lock`. Running one by hand beside PM2 is
  refused this way; if the hand-run one started first, PM2's runner stopped
  with 78: stop yours, then `pm2 restart ravi-gateway`. A lock left by a
  dead runner is replaced automatically; never delete a lock whose pid is
  alive.
- Exit 75 (PM2 restarts): settings changed (below), `listener_unarmed` (the
  daemon's listener went away or moved port; the restarted runner waits for
  it), or `stale_cloudflared_alive` (a cloudflared left by a dead runner
  survived SIGKILL: check `ps -p <pid>`; the runner retries on restart and
  never starts a second one beside it).
- `gateway.tunnel.metricsPort` (default 20241) and the stored credentials are
  read at runner start; after changing either, `pm2 restart ravi-gateway`.
  A change to the listener port, tunnel hostname or Access settings is picked
  up by itself: the runner exits 75 and PM2 restarts it with a new template.

## Drift

| Reason | Meaning | First step |
| --- | --- | --- |
| `config_version` | cloudflared applied a remote configuration | Treat as a compromise of the tunnel's Cloudflare account path: Console RUNBOOK §Unexpected Connector; rotate |
| `ingress_mismatch`, `warp_routing` | `/config` differs from the template | Same; capture `curl -s 127.0.0.1:<metricsPort>/config` first |
| `metrics_socket_owner` | Another process owns the metrics port, or neither `lsof` nor `ss` exists (a slow or failing `lsof` is retried and ends as `poll_stale`) | `lsof -nP -iTCP:<port> -sTCP:LISTEN`; install `lsof` or `iproute2` if missing |
| `poll_failed`, `poll_stale`, `config_unparseable` | cloudflared stopped answering, hung, or the runner stalled | Check the host (sleep, load), then rotate |

- The latch is cleared only by a successful rotate/re-expose (05b). Do not
  delete the `tunnel.drift_latch` row by hand: it is the record that the
  tunnel served something other than the host's template.
- `~/.ravi/gateway/tunnel-drift.latch` exists only when the database refused
  the latch write (the log says `writing the fallback latch file`). It is a
  latch like the row (runner and listener both refuse) and the same rotate
  clears both; find out why ravi.db refused the write before rotating.
- While latched the listener answers 503 `tunnel_drift` and `ravi gateway
  status` (05b) reports it; Console sees `driftLatched` in the host report.

## Live checks still open (first run with a real tunnel)

- cloudflared at the pinned version accepts `TUNNEL_CRED_CONTENTS` for `tunnel
  run` with an API-created local tunnel (Console C3a spike item).
- The exact `/config` JSON of that version matches what `checkRemoteConfig`
  expects (rule `service` as a string, `path` null or absent, `access` keys
  `required`/`teamName`/`audTag`, `warp-routing.enabled` absent or false). A
  latch with `ingress_mismatch` on the first ever poll is this check failing:
  capture the body and adjust the comparator, never loosen it to "ignore".
- PM2 honours `--stop-exit-codes 78` and `--kill-timeout 8000` on the
  installed PM2 version.
- `lsof -iTCP@127.0.0.1:<port>` lists cloudflared's metrics socket on macOS
  and Linux without root.
- PM2 tree-kill on stop: `pm2 stop ravi-gateway` (PM2 `treekill` default)
  signals cloudflared directly as well as the runner. Confirm cloudflared
  exits within its 1 s grace, the runner exits with its code, and
  `tunnel.runner` / `last_poll_at` are cleared (no orphan in `ps`).
- `/config` never exposes credentials: `curl -s 127.0.0.1:<metricsPort>/config`
  on the pinned version must not contain `TunnelSecret`, the AccountTag or
  the `TUNNEL_CRED_CONTENTS` JSON; if it ever does, stop and treat the
  metrics port as a secret channel (and the runner's log of drift bodies).
- `warp-routing` field presence: capture whether the pinned version's
  `/config` includes `warp-routing` at all (and `enabled: false`) with the
  template's `warp-routing.enabled: false`; `checkRemoteConfig` accepts it
  absent or false, and the capture decides whether "absent" can be
  tightened.

## Residual risks

- A SIGKILLed runner leaves cloudflared running until the next runner start
  stops it (and waits for it); the listener closes within 10 s (no fresh
  poll), so nothing is served meanwhile, but the tunnel stays connected.
- No confinement of cloudflared on macOS (milestone 1, Console §Confinement);
  Linux confinement is not implemented yet: the runner refuses on Linux
  (`platform_unsupported:linux`) and `expose` must too (05b).
- Until the darwin executable hash and the Team ID are pinned, a darwin
  install relies on the GitHub digest alone, and only with the explicit
  `RAVI_CLOUDFLARED_SKIP_*` overrides.
- The single-runner lock trusts pid liveness: a crashed runner whose pid is
  reused by another live process makes the next runner refuse with
  `runner_already_running` until that pid exits or the stale lock is removed
  by hand after checking `ps -p <pid>`.
