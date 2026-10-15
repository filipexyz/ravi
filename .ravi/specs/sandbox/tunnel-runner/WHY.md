# Sandbox Gateway Tunnel Runner / WHY

## Rationale

### Credentials in cloudflared's environment, never in a file or argv

Console's listener SPEC allows `--credentials-contents` / `TUNNEL_CRED_CONTENTS`
or a `0600` credentials file. argv is visible to every local user in `ps`, so
the flag is out. A file would have to live somewhere for the whole life of
cloudflared and be cleaned up after a crash; the environment variable exists
only in the child, is readable only by the same uid (the same exposure as a
`0600` file) and disappears with the process. So no credentials file is ever
materialised; the only file at rest is the store's own fallback
(`~/.ravi/gateway/tunnel/credentials.json`, `0600`) when no Keychain or
Secret Service is selected. The runner's own environment, and therefore the
PM2 entry `pm2 save` persists, never holds the secret, and `buildPm2Env`
drops every `TUNNEL_*` variable (by prefix: cloudflared reads all of them as
flags, not only `TUNNEL_TOKEN`) in case an operator exported one.

### The latch and the poll timestamp live in ravi.db, not in settings

The poller runs in the runner process; the listener runs in the daemon. They
share ravi.db, so `sandbox_listener_state` carries the latch and the last
successful poll across the process boundary with a 1 s read cache on the
listener side. A `gateway.*` setting would restart the listener on every
write (the reload hook) and could be cleared with `ravi settings set`. A
runner that dies stops writing `last_poll_at`, so the listener closes itself
within 10 s even if cloudflared was orphaned.

### Exit 78 and `--stop-exit-codes 78`

Console says a drift stop disables the supervisor's automatic restart. PM2
restarts any exit by default; exit 78 (`EX_CONFIG`) is registered as a stop
code, and a runner started anyway (host reboot, `pm2 resurrect`) reads the
latch first and exits 78 again. Refusals for missing settings or credentials
use the same code: restarting cannot fix them.

### A startup grace before the first poll succeeds

cloudflared needs a moment to bind its metrics server. Latching on the very
first connection refusal would make every start a coin toss that only a
rotate can undo. Before the first success the listener is closed anyway
(no `last_poll_at`), so retrying a connection-level failure for up to 10 s
opens nothing; a reported remote version, a template difference or a foreign
socket owner is drift immediately, grace or not.

### Socket ownership through `lsof`/`ss`

Console requires the host to confirm the metrics socket belongs to the
cloudflared it launched before trusting `/config` (another local process
could bind the port and serve a template-shaped answer). Node has no API for
it; `lsof -iTCP@127.0.0.1:<port> -sTCP:LISTEN -Fp` (macOS, most Linux) and
`ss -ltnp` (iproute2) do. When neither exists, ownership is unverifiable and
that is drift: fail closed. A tool that exists but is slow (a loaded host,
`lsof` walking every fd) is not evidence of anything, and latching on it
would need a rotate to undo a load spike; it is retried like a connection
failure, and the 10 s staleness rule still closes everything if it never
recovers.

### One runner, and no orphaned cloudflared

A second runner (a `tunnel-run` by hand beside PM2) would spawn a second
cloudflared, overwrite `tunnel.runner`, and on exit clear the first one's
record and close its gate; the first one then sees a foreign socket owner and
latches. An `O_EXCL` lock file with the holder's pid makes the second one
refuse instead; pid liveness detects a lock left by a crash. Reaping a stale
cloudflared waits for it to die (SIGTERM, SIGKILL, bounded) because the
first poll runs immediately: a reaped-but-not-yet-dead cloudflared still
owns the metrics port and would read as drift. If it survives SIGKILL the
runner exits 75 and keeps the record rather than start a second one. For the
same reason `tunnel.runner` is cleared only once the child has exited, and
any exception after the spawn stops the child first.

### darwin only until confinement is verified

Console's §Confinement requires cloudflared on Linux to run under a dedicated
uid with nftables limiting it to the listener port. That is not implemented,
and an unconfined cloudflared on a Linux host reaches every local service.
The runner itself refuses there (exit 78), not only `expose`, so a
hand-registered PM2 entry cannot bypass it.

### Two independent checks on the darwin binary

The pinned archive digest comes from the same GitHub release that serves the
bytes, and the darwin release-notes hashes never match it, so on darwin the
digest alone has no second source. The Developer ID signature is one:
`codesign --verify --strict` with a designated requirement that pins an
Apple-anchored leaf to Cloudflare's Team ID fails for anything Cloudflare did
not sign, whoever served it. The executable's own SHA-256, re-checked on
reuse and at every runner start, catches a binary swapped at rest. Neither
value can be derived offline (the Team ID must be read from a signed binary,
the hash needs the extracted bytes), so both are explicit `null`
placeholders that refuse until a human pins them, with named overrides for
a deliberate unpinned install.

### A fallback latch file

The latch row is written before cloudflared is stopped; if ravi.db refuses
the write (locked, read-only, full disk) the drift would otherwise be
forgotten on the next start. A `0600` file next to the gateway state is a
second, independent place the runner and the listener both read first.

### Monotonic staleness

The 10 s staleness rule is measured by the runner itself; a wall-clock step
(NTP, sleep/wake) would otherwise read as a stalled poller and latch. The
persisted `last_poll_at` stays wall-clock because the listener, in another
process, compares it with its own clock.

### cloudflared dies with its poller (as far as a process can)

There is no portable parent-death signal from Bun. The runner forwards
SIGTERM/SIGINT, gives cloudflared `--grace-period 1s` and PM2 an 8 s kill
timeout so a normal stop never SIGKILLs the runner first, stops cloudflared
when the poll loop throws, and on the next start stops a cloudflared left by
a runner that died. A SIGKILLed runner can still leave cloudflared running
until then; the listener's 10 s freshness rule closes the gate meanwhile.

### Redirects only to GitHub's release hosts

GitHub release downloads always redirect from `github.com` to a
`*.githubusercontent.com` object host, so "no redirect to another host" would
make the install impossible. The redirect allowlist names the hosts GitHub
uses, requires `https`, and the SHA-256 is the real guarantee either way.

### Pinned hashes from GitHub's asset digest

The hashes are the `digest` GitHub's release API reports for each asset,
computed over the bytes it serves. For Linux they equal the release notes'
"SHA256 Checksums". For the darwin `.tgz` assets the release-notes values
differ from the served bytes in every recent release (RUNBOOK §Pinned
release); pinning the notes' value would make every macOS install fail the
check, so the served-bytes digest is pinned and the discrepancy recorded.

## Plan items the spec superseded

- Plan §05a: "spawns cloudflared with `TUNNEL_TOKEN`… args `tunnel
  --no-autoupdate run`". Console provisions a locally managed tunnel and
  returns the credentials-file object, not a token; the host writes the
  ingress. So: `TUNNEL_CRED_CONTENTS` in the child env, `--config` with the
  host template, `--metrics 127.0.0.1:<port>`, `run <TunnelID>`.
- Plan §05a: "stores the tunnel token" → stores the credentials object,
  validated field by field.
- Plan §05a has no drift poller (it assumed a remotely managed tunnel).
  Console's §Drift Check and ADR 0002's 04b follow-up put the poller, the
  persistent latch and the listener's per-request read in this slice.
- Plan §05a: "HTTP redirect to another host is refused" → refused unless the
  host is a GitHub release host (above).
- Plan §05b item 6 ("restart the daemon to start the listener") is replaced by
  the listener reload on `ravi.config.changed` (ADR 0002 #8), done here.
