# Canonical gateway for Console delegation

This change stacks on Ravi #761 (`e19bb52f89d19cbe72731229ba196e38479da520`).
The matching Fleet implementation stacks on Fleet #3
(`95ac64604f5cd88d1a661334709047a0f144354f`). No deployment is performed here.

The dedicated Console Unix listener now transports ordinary gateway HTTP and SSE
through the fixed `ravi bridge serve-stdio` SSH byte forwarder. The NDJSON v2
handler and its operation/grant schemas are removed. Enrollment, private SQLite,
runtime execution, capability attenuation and exact-action approvals are reused.

`SessionConversationCommands` declares private-session APIs in the CLI registry.
They pass through `handleGatewayRequest` and the existing dispatcher/validator,
and generate TypeScript, Dart, Swift and OpenAPI. Internal BridgeService inputs
are storage-adapter types, not a second wire protocol. `sessionView` belongs to
the existing stream registry and generates SDK methods as well.

## Authority and coverage

- Console requests require Ed25519 delegation <=30s. Pinned runtime proof binds
  connection nonce and catalog digest. Request binds exact HTTP bytes, subject,
  org/install/enrollment/epoch/project/resource, command/action, policy revision,
  operation ID and typed browser/channel/automation origin. New JTI on each retry.
- Verified invocation lives in AsyncLocalStorage. Local contexts and Console
  grants cannot cross listeners or fall back to local operator authority.
- `CommandAccess.consoleScope` marks reviewed resource resolution, not permission.
  The remote catalog includes only supported entries. All private conversation
  commands and existing set-model/set-thinking/set-display controls are supported;
  the latter resolve only the durable owner-bound session. Propagation is denied.
- Other command families, fork/reset/rollback, unbound channel sessions, CliOnly,
  superadmin and debug streams remain unavailable remotely. No name-based adoption.
  A future command needs a resource resolver, Console policy action and isolation
  tests; adding metadata alone is not an authorization decision.
- Control authority cannot grant runtime tools. Per-agent signed capabilities,
  approval grants and short execution leases remain separate. No provider support
  was expanded. Configuring a session requires it to have been materialized by
  the runtime. No model/thinking/display UI controls were added in this delivery.

## Persistence and recovery

Private sends atomically persist receipt, message and execution row. Repeated
operation IDs never duplicate a turn; changed payload conflicts. Generic controls
persist admission before effects and return EXECUTION_UNKNOWN if a final receipt
was not recorded. A post-effect audit/storage failure also remains unknown.
Retry requires current ownership/authorization and never reexecutes an uncertain
control. Receipt namespaces cannot reuse IDs across command families.

Policy high-water updates survive denied dispatch. Expiration/revocation affects
queued/active work; reads/SSE do not renew execution leases. Cursor binds owner,
project, enrollment epoch and conversation. The SSE journal uses bounded batches
and pull/backpressure and never publishes raw provider/tool/reasoning events.
The current data store remains private `bridge.db`; ordinary local/admin session
history and knowledge paths remain blind to it.

Console owns message delivery identity and confirmation in its Postgres table;
Ravi owns execution journal and recovery. The runtime origin contract supports
future channel/automation adapters without a web session. This does not migrate
live connectors or change their current authority.

## Tests and operation

Run the focused suites with `--preload ./src/test/isolated-runtime-preload.ts`:
`src/sdk/gateway/console.test.ts`, `src/bridge/service.test.ts`,
`src/permissions/scope.test.ts`, `src/runtime/runtime-request-context.test.ts`.
Use an explicit disposable RAVI_STATE_DIR, then build, quality, full suite and
Swift SDK tests. Never point validation at the live installation.

Fleet's paired integration test uses this real listener, SQLite and restricted
SSH HTTP/SSE, with a fixture turn executor. Browser tests use real Next/OIDC and
Postgres with mocked remote replies. Historical model E2E results do not validate
this revision; native model/sandbox homologation remains a gate before enabling
an installation. Actual commands/results and final commit hashes are recorded in
the delivery report, not inferred from previous reports.

Future rollout requires separate authorization: migrate Fleet delivery metadata,
update both binaries together and then enable/restart only the approved runtime.
There is no v2 fallback. Preserve SQLite/journal and operation IDs on rollback;
do not retry unknown external effects under new IDs. No merge, live migration,
production deployment, DNS, machine permissions or daemon restart occurred here.
