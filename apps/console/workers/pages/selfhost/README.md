# Private single-installation Pages runtime

This is an adapter for the existing Pages handler, not a static server. Console
still owns sites, releases, publish, sessions, Bases, chat messages and policy.
Use only on the isolated staging branch; this document does not authorize a deploy.

## Start and configuration

`bun workers/pages/selfhost/server.ts` (image: `workers/pages/Dockerfile`).
Container UID/GID is `10001:10001`; mount the dedicated writable data volume at
`/var/lib/ravi-pages`. It contains `runtime.sqlite` and its WAL/SHM. Back up SQLite
consistently using an online backup or a stopped runtime, not a raw live file copy.
No Pages-specific Postgres migration is introduced by this package. Auth/runtime
packages have their own migrations, which the coordinator must apply in order.

All adapter settings support either the named environment variable or its
`_FILE` sibling. Do not place secrets in Dockerfiles, git, arguments or logs.

- `RAVI_PAGES_TRUST_PROXY=1`: required. Listener is only reachable by the trusted
  private proxy. Proxy overwrites `X-Forwarded-Proto` and preserves canonical Host.
- `RAVI_PAGES_BIND=0.0.0.0`, `PORT=8787` inside private Compose network. Never
  publish this listener publicly; host bindings, if any, must be loopback.
- `RAVI_CONSOLE_API_URL=https://console.nba-console.localhost`: canonical HTTPS
  Console origin, resolvable in the container with explicit staging CA trust.
- `RAVI_PAGES_CONTROL_TOKEN`: dedicated random control credential, shared with
  Console, distinct from auth/session keys.
- `RAVI_PAGES_HOSTED_DOMAIN=pages.nba-console.localhost`: same value in Console.
  Site hosts are `<project-pages-slug>.<domain>`; each site is a trust boundary.
- `RAVI_PAGES_R2_ENDPOINT`, `RAVI_PAGES_R2_BUCKET`, `RAVI_PAGES_R2_ACCESS_KEY_ID`,
  `RAVI_PAGES_R2_SECRET_ACCESS_KEY`, `RAVI_PAGES_R2_REGION=us-east-1`: path-style
  S3-compatible storage. The names retain the existing product contract; set the
  same explicit region/endpoint/bucket in Console rather than relying on its
  Cloudflare-oriented default. Private internal HTTP storage may be used in the
  isolated Compose network; browser uploads still need an authorized reachable
  transport selected by the coordinator. The Pages bucket is never public.
- `RAVI_PAGES_STATE_DIR=/var/lib/ravi-pages`.
- `RAVI_PAGES_CAPTURE_PROVIDER=playwright` in Console. Optional adapter settings:
  `RAVI_PAGES_BROWSER_EXECUTABLE`, `RAVI_PAGES_BROWSER_TLS_SPKI` (comma-separated
  exact base64 SHA-256 SPKI pins, only for explicit isolated test certificates).
  Chromium runs sandboxed. Do not fix a container sandbox error with `--no-sandbox`.
- `RAVI_PAGES_CHAT_ORIGIN` is optional; default keeps panel within each Page's
  own origin. Distinct site origins must never share a wildcard Pages cookie.
- Voice API code is preserved. `OPENAI_API_KEY` remains unset unless separately
  authorized. DeepSeek only validates text, not realtime/WebRTC voice.

Console requires `RAVI_AUTH_MODE=oidc` for the single-installation origin gate.
`publish_origin_grants_conflict` means the same origin would contain incompatible
route capabilities. Publish to separate registered sites/origins, currently via
separate project-owned hosts. Explicit empty `uses` and absent `uses` differ:
empty permits only the always-allowed theme read; absent uses curated platform
reads. Existing incompatible releases return `connector_origin_grants_conflict`.
Equal-grant paths remain one shared trust domain, never isolated routes. View
resource policies are site/user policies and do not become path-specific ACLs.

## State and limitations

- Asset streaming/metadata and immutable key/release behavior use the existing
  handler. This package does not add HTTP range/conditional-response features
  absent from that handler; it preserves existing behavior and ETag headers.
- SQLite usage outbox retries with the original event idempotency keys. Exhausted
  retries remain visible in `pages_usage_outbox.failed=1`, not silently dropped.
- WebSocket room authorization remains in Console. Sockets expire after 60s to
  require current authorization; durable history/sequence catchup comes from
  Console. A Pages restart disconnects and reconnects, not seamless socket HA.
- Voice state/alarms persist in SQLite; arbitrary provider socket continuation
  across process restart is not promised or validated.
- Captures allow same-origin HTTP requests only and block WebSockets. Verify
  sandbox/network controls inside the actual deployment before using customer
  content. Staging tests use synthetic content only.
- Executor delegation happens after membership, origin grant and input checks.
  Only human-viewer sessions are delegated; the internal callback re-runs the
  same service without a loop. Capture/system reads keep their narrow local path.

## Tests

`bun test workers/pages src/server/console/pages/hosted-domain.test.ts src/server/console/pages/connectors/origin-policy.test.ts src/server/console/pages/connectors/host.test.ts src/server/console/pages/auth.test.ts src/server/console/pages/publish.test.ts`

`PAGES_BROWSER_TEST=1 bun test workers/pages/selfhost/capture.integration.test.ts workers/pages/selfhost/isolation.browser.test.ts`

The latter runs real Chromium and temporary TLS certificates with exact SPKI pins,
never global trust changes or blanket `ignoreHTTPSErrors`. The cross-origin test
uses a synthetic Console/storage fixture and is not real IdP/Postgres/Executor
acceptance. The coordinator owns that separate integrated proof and screenshots.
