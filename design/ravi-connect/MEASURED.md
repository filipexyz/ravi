# Measured on 2026-11-17 and 2026-11-18 (real gateway code, isolated state)

Evidence log for `design/ravi-connect`. Every run used a copy of the repository source (commit cb92032) with an
isolated `RAVI_STATE_DIR`; nothing touched a real `~/.ravi`. The experiment scripts named below were session
scratch files and are not in the repository; the end-to-end test that is kept lives in `test/`.

The real gateway code was run from a copy of this repository (commit cb92032, dependencies
installed in the copy) with an isolated `RAVI_STATE_DIR`, no NATS, the real `ContextCommands` in the
registry, the unix-socket listener (`startHostCliGateway`) and a standalone TCP listener
(`startGateway`) built from the same gateway configuration. Scripts:
`exp.ts` and `page-probe.cjs` (session scratch files, not kept in the repository).
Nothing touched `~/.ravi` or either repository. A TCP-to-unix-socket byte relay stood in for the data
path of `ssh -L <port>:<remote socket>` (no sshd is available in this environment, so SSH itself was
NOT run).

Through the unix socket (`cli-gateway.sock`, same handler as the TCP listener):
- `GET /api/v1/_meta/version` without a key: 200.
- `POST /api/v1/context/whoami` without a key: 403 `PERMISSION_DENIED` ("command execution requires a
  resolved runtime principal"). With an unknown key: 401 `AUTH_REQUIRED` ("unknown context key").
- `POST /api/v1/context/issue` with the admin-bootstrap key and body
  `{"cliName":"painel-teste","allow":"view:system:events,read:context:whoami","ttl":"1h"}`: 200, a child
  context of kind `cli-runtime`, `parentContextId` set, expiry one hour ahead, exactly the two
  capabilities asked for. (A body field `json` is rejected as an unknown key.)
- The child key calling `context whoami`: 200, `issuedFor: "painel-teste"`.
- The child key calling `context issue` asking for `admin:system:*`: 403 `PERMISSION_DENIED`
  (missing `mutate:context:issue`).
- CORS: an `OPTIONS` preflight with an origin listed in `RAVI_CORS_ORIGINS` gets
  `access-control-allow-origin` and the allowed headers; an unlisted origin gets no CORS headers.

Streams (a test channel that emits one event at once, a second after 2.5 s, then ends):
- TCP listener: first byte after 21 ms, three chunks, total 2.8 s. It streams.
- Unix socket: first byte after 2.8 s, one chunk. The whole response arrives at the end. SSE does not
  stream through `cli-gateway.sock` today; ordinary commands do work through it.

A hosted HTTPS page in Chromium 153 (automation build), served with the ravi.page CSP, calling
`http://127.0.0.1:<relay port>` where the relay forwards bytes to the unix socket:
- Without the local-network permission: every call fails.
- With the permission and the page origin in `RAVI_CORS_ORIGINS`: `_meta/version` 200; `context whoami`
  with the child key 200; the escalation attempt 403; the stream returns 200 but its first byte arrives
  only when the stream ends (2.8 s), as above.
- The same call from a page whose origin is not listed: fails (no CORS headers).

Caveats
- In this harness the admin context was created with `createRuntimeContext` and no agent, so the child
  had `agentId: null`. A real `ravi daemon init-admin-key` binds the admin key to the `bootstrap` agent
  (`src/cli/commands/daemon.ts:1351`), and children inherit it. Scope code treats an agent-less context
  as the local operator (`src/permissions/scope.ts:327`), so no conclusion about resource scoping can
  be drawn from this run.
- `ssh <vps> ravi context issue ...` and a real `ssh -L` were not run (no sshd here). Expiry was
  exercised in the third run, below.

## Second and third runs (TCP listener, same real gateway code; scripts `exp2.ts`, `exp3.ts`)

Here the admin-bootstrap context was bound to an existing agent, as a real `init-admin-key` does.
- A child issued by `context issue` inherits the parent's agent id.
- Asking for `--ttl 30d` under a parent that expires in 60 minutes yields a child that expires in 60
  minutes: the child's expiry is capped by the parent's.
- `--ttl 2s` is refused by the command (422 `COMMAND_FAILED`); a 3-second child was created through
  `issueRuntimeContext` directly for the expiry test.
- Expired key on a command: HTTP 401, code `CONTEXT_EXPIRED`, cause "The runtime context credential has
  expired.", and the error body says `retryable: false`.
- Revoked key on a command: HTTP 401, code `AUTH_REQUIRED`, cause "context has been revoked". The two
  cases are distinguishable by code.
- An open stream whose key expires is closed by the server at expiry (closed 3039 ms after a 3 s key
  was issued). The stream simply ends after the last event; no terminal error event was observed.
- An open stream whose key is revoked closed 314 ms after the revoke call returned (events were flowing
  every 500 ms; the server re-checks on each event and every 5 s).
- Revoking the admin context cascades: a child issued from it gets 401 `AUTH_REQUIRED` afterwards.
- `context revoke` has no ownership test: a client key that holds `mutate:context:revoke` revoked the
  context of ANOTHER client by context id (200), and the other client's key then got 401.

## Fourth run: how long a key can live today (script `exp4.ts`, real gateway code, admin key of 90 days)

- `context issue --ttl 30d` gives a child that lives 30 days; `--ttl 89d` gives 89 days; `--ttl 365d`
  is capped at 90 days (the admin key's remaining life); `--ttl 0m` also yields the parent's expiry
  (90 days); with no `--ttl` the child lives 1 hour.
- A long-lived child ("link key", 60 days) that holds `mutate:context:issue` plus the app's
  capabilities can itself issue short children (1 hour) limited to its own capabilities. Asking for a
  capability it lacks is refused (403, "Capability not granted by parent context"); asking for a longer
  life is capped at the link key's expiry. Revoking the link key makes the keys issued from it fail
  with 401 `AUTH_REQUIRED`.
- So, with no gateway change, "approve once and stay linked" can last up to the life of the admin key
  (90 days at most), as a durable link key that mints short access keys. What is missing for more than
  that is an issuer that outlives the admin key.

## Fifth run: a working prototype of "approve once, stay linked" with NO gateway change

Files: `connect.js`
(page side; the prototype that `skill/connect-installations/assets/connect.js` grew from), `driver.cjs` (plays the approving agent and drives Chromium 153), `gateway.ts` (real
gateway code, isolated state, TCP listener, page origin in `RAVI_CORS_ORIGINS`).
- The page (served with the ravi.page CSP) generates an ECDH P-256 key pair with `extractable: false`
  and keeps the private key in IndexedDB. Its request carries its origin, the capabilities it asks
  for, its public key and an 8-character code derived from a hash of the whole request.
- The approver (here the driver, using the admin key as an operator would) issues a link key with
  `context issue --allow mutate:context:issue,<caps> --ttl 60d`, seals `{baseUrl, linkKey, expiresAt}`
  to the page's public key (ephemeral ECDH + AES-GCM, with the request id and origin as associated
  data) and publishes the sealed envelope at `/_link/<id>.json` on the PAGE'S OWN host.
- The page fetches the envelope from its own origin, opens it in memory, issues itself a 1-hour access
  key with the link key and calls the gateway: 200.
- At rest the browser holds only the non-extractable private key and the sealed envelope; no `rctx_`
  string is stored in the clear.
- A later visit (new page load, same browser profile) is linked with no approval and gets a new
  1-hour key. Another browser profile that fetches the same envelope cannot open it.
- Revoking the link key on the installation: the next visit reports `needs-login` (401
  `AUTH_REQUIRED`) and the access key issued earlier stops working.
Limits: any script on the same origin can use the stored key; the link key is still a bearer once
opened in memory; the lifetime ceiling is the admin key (90 days).

## Sixth run: resource scoping of a child key (script `exp5.ts`, real gateway code, 2026-11-18)

Admin-bootstrap context bound to an agent `bootstrap` (as a real `init-admin-key` does); two other
agents with one session each; registry with the real context, sessions and agents commands.
- A child holding only command capabilities (`read:sessions:list`, `read:sessions:info`,
  `read:agents:list`, `mutate:sessions:send`): `sessions list` answers 200 with an EMPTY list,
  `agents list` shows only its own agent, `sessions info` answers 422 `SESSION_NOT_FOUND`
  ("not found, or not visible to this context") and `sessions send` 422 "Session not found".
  The gateway filters by scope (`src/permissions/scope.ts`: `filterAccessibleSessions`,
  `canAccessSession`, `canViewAgent`), so command capabilities alone show nothing.
- Adding the two resource relations `access:session:*` and `view:agent:*`: both sessions and all three
  agents are listed, `sessions info` answers 200. Without `mutate:sessions:send` a send is refused
  with 403 `PERMISSION_DENIED`; `sessions reset`, `context issue` and `context revoke` are 403 too.
- With `mutate:sessions:send` added, a send passes authorization and reaches the publish step (it
  fails here only because the harness has no NATS: 422 `SESSION_RELAY_FAILED`). `sessions reset` and
  `sessions delete` stay 403.
- A narrower grant works: `access:session:<name>` instead of the wildcard lists only that session.
So a usable preset needs the command capabilities AND the relations `access:session:*` and
`view:agent:*`; these two are the only wildcards a preset may carry.

## Seventh run: the REAL CLI entrypoint against the real gateway (scripts `exp6-gw.ts`, shell; 2026-11-18)

The stand-in `ravi` used by the bundle's end-to-end test was replaced here by the real CLI source entrypoint
(`bun src/cli/index.ts`), in isolated state, talking to the real gateway code through `RAVI_GATEWAY_URL`
(a real installation uses the daemon's unix socket; same client code, other transport). No ssh.
- With `RAVI_CONTEXT_KEY` set and no gateway reachable the CLI refuses: exit 1, `GATEWAY_REQUIRED`.
  With no key at all: exit 1, `REMOTE_CONTEXT_REQUIRED`.
- The pipeline of `references/instalacao.md` step 3, verbatim, with the admin key in the environment:
  the issuer key lands in a 0600 file, 89 days, nothing but "gravado <contextId> vence <date>" printed.
- `context issue <name> --allow <caps> --ttl 60d --json` with the issuer key: exit 0, stderr empty, stdout
  is one pretty-printed JSON object with `contextId`, `contextKey`, `parentContextId`, `expiresAt` (number,
  60.00 days ahead), `capabilities` (objects `{permission, objectType, objectId}`) and `env.RAVI_CONTEXT_KEY`.
- `context whoami --json`: `expiresAt` (number) and `capabilities` (objects) at the top level.
- Asking for `admin:system:*` with the issuer key: exit 1, stdout
  `{success:false, op:"context issue", error:{code:"PERMISSION_DENIED", message:"Capability not granted by parent context: admin:system:*"}}`.
- `context info <id> --json` with a key holding only `mutate:context:revoke,read:context:info`: exit 0,
  top-level `issuedFor`, `parentContextId`, `status`; the output carries no key. A missing id: exit 1,
  `CONTEXT_NOT_FOUND`.
- `context revoke <id> --reason <text> --json` with that key: exit 0, `{context:{status:"revoked", ...}}`.
So the helper's parsing of the CLI output (used over ssh) matches the real CLI. Still not run: ssh/sshd
and an installed, bundled `ravi` on a VPS.
