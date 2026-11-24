# Credential Broker Checks

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/file-backend.test.ts src/credentials/backends.test.ts src/credentials/intake.test.ts`
- Verify private-file connection intake resolves through the existing broker and
  no token appears in connection metadata, logs, errors or audit.

## PoC Regression

```bash
bun test pocs/credential-broker/broker.test.ts
```

## Production Regression

When production files exist:

```bash
bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts
```

Core validation before merging:

```bash
bun run typecheck
bun run build
```

## Dry Run Checks

`broker exec --dry-run` MUST:

- Return required capabilities.
- Return approval requirement.
- Return `secretResolved=false`.
- Not call backend `read`.
- Not create provider-side effects.

## Authorization Checks

Tests MUST cover:

- Missing connection denies before backend read.
- Disabled connection denies before backend read.
- Missing `use:credential:<provider>:<connection>` denies before backend read.
- Missing `execute:<provider>:<action>` denies before backend read.
- Sensitive action requests approval before backend read.
- Approval denial prevents backend read.
- On the author's own human turn, with the contact holding both
  capabilities, a non-destructive write reads without a card and is audited
  as `actor_authorized` with `approval_required = 1`.
- `*.archive`, `*.kick`, `*.delete` and `*.remove` still ask for approval on
  the author's own turn.
- A call marked `destructive: true` (`canvases.edit` with a `delete` change)
  asks for approval on the author's own turn, while the same `canvases.edit`
  without the mark passes; `ravi slack canvas-edit` sends the mark for
  `delete` and for a whole-canvas `replace`, and not for a section
  `replace`.
- `src/channels/slack/credentials.ts` forwards `destructive` to the broker
  only when set.
- The exception never applies to a provider other than `slack`.
- Agent, system and unknown turn origins never skip the card.
- An approval refusal keeps `detail` only for fixed approval-service text;
  an arbitrary reason (exception text) is dropped.
- Cron/trigger provenance, missing provenance, agent relay, unresolved
  speaker, thread projection, an author without the action and a blocked
  author never skip the card.
- Conversation reads (`conversations.history` and the rest of the read set)
  ask nobody.
- An invalid key never falls back to default credentials or operator-control.
- Stale in-process context copies cannot survive revocation or capability removal.
- A missing executor or blocked invocation actor cannot use a saved snapshot.
- Both the issued scope and current executor ceiling apply, including narrowed children.
- External provider `deny` and `needs_approval` prevent backend read, including
  after a local human approves a sensitive operation.
- Revocation or connection changes during approval prevent backend read.
- Named internal Slack bootstrap authority works without an invocation and
  cannot override an invocation, select another provider or run unrelated actions.
- Slack adapter resolution uses the checked broker path and does not expose the
  token in action output, audit or diagnostic errors (including nested causes).

Focused host-safe regression:

```bash
bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/broker-authorization.test.ts src/credentials/credentials.test.ts
```

## Lifecycle Checks

Tests SHOULD cover:

- Disabled connection denies before backend read.
- Expired connection denies before backend read.
- Successful broker execution is visible as `lastUsedAt` in the inventory
  (derived from the latest `secret_resolved` audit row; a failed attempt does
  not count): `src/credentials/inventory.test.ts`.
- Rotation (`connections add --secret-stdin` over an existing connection)
  sets `rotatedAt`; creation and `--secret-ref` do not:
  `src/cli/commands/credentials.test.ts`.
- `disabledAt` is set on disable, kept on re-disable and cleared on enable;
  lifecycle fields survive updates that do not mention them; a database from
  before the lifecycle columns gains them and keeps its rows:
  `src/credentials/inventory.test.ts`.

## Inventory Checks

`src/credentials/inventory.test.ts` MUST prove, each with a mutant that fails it:

- `describeSecret` calls only `GET .../metadata/...` (mutant: data endpoint);
- 403, 503, network failure and missing config degrade with fixed reasons
  (mutant: 403 accepted);
- the snapshot carries no secret value, Vault path, key or Vault token even when
  the backend would return the value from the data endpoint (mutant: raw ref as
  alias);
- `unsupported` (file/keychain) is not a degradation (mutant: every
  unavailable reason degrades);
- `lastUsedAt` counts only `secret_resolved` (mutant: any audit row).
- Removing a connection can optionally delete backend secret material.

## Secret Redaction Checks

Tests MUST assert that these surfaces do not include secret values:

- CLI JSON output.
- Human CLI output.
- thrown errors.
- audit events.
- log events.
- provider action result.

Search changed files before closing:

```bash
rg -n "secretResolved|secretRef|redact|console\\.(log|error|warn)" src/credentials src/cli/commands/credentials.ts pocs/credential-broker
```

Review every output path manually.

## Backend Checks

Keychain:

- Write dummy secret.
- Read through broker only.
- Delete backend secret.
- Confirm item not found after cleanup.

Vault:

- Write dummy secret to KV v2.
- Preserve sibling keys.
- Read through broker only.
- Delete only the configured key when siblings remain.
- Redact missing key and HTTP errors.
- Add CAS/version check before production concurrent usage.

## Audit Checks

Audit rows MUST include:

- provider
- connection
- action
- context/agent/session identifiers when available
- decision
- approval status
- secret ref alias/redacted coordinate
- result status

Audit rows MUST NOT include:

- provider token
- Vault token
- authorization header
- backend response body
- request body containing secret material

## CLI Checks

`ravi credentials connections list` MUST use standard pagination fields:

- `total`
- `pagination.limit`
- `pagination.offset`
- `pagination.returned`
- `pagination.hasMore`
- `pagination.nextCommand`
- `items`

All commands MUST have `@CommandAccess` metadata.

## Slack action classification

```bash
bun test src/cli/commands/slack-credential-actions.test.ts
```

Reads the TypeScript AST of `src/cli/commands/slack.ts` and fails when: a
credential entry point is called outside the four known forwarding calls and
the classified sites; a forwarding call's arguments differ from the pinned
text; an entry-point name is used other than as its declaration or a direct
call (alias, other receiver, value); a mutation call's object has a spread;
an entry point is exported or re-exported, or a mutation method is not
`private`; a site's action is not a string literal (or a
conditional / same-function `const` of literals); the number of sites for an
action or in total differs from the table; the broker's read/write/destructive
class differs from the table; a whole-canvas publisher's top-level
`destructive` is not the literal `true`; or a non-literal `destructive` appears
anywhere but `canvases.edit`. Comments never count.

Out of reach of this test (code review owns them): string or computed keys
(`this["mutationOpsContext"](...)`) and mutation of the argument after it is
built.

## Native Omie guard regression

- `bun test --preload ./src/test/isolated-runtime-preload.ts src/credentials/broker-authorization.test.ts`
  proves the host guard runs after approval and before secret access; denial,
  revoked caller and changed/disabled connection prevent backend resolution.
- `bun run test:omie-orders` proves exact provider read classification, secrets
  remain inside the host, echo values are redacted, and identity/membership/live
  contact permissions are rechecked after awaited work before provider HTTP.
- `identity.test.ts` keeps child capabilities and channel membership intact while
  removing a real permission tag through the contacts API. Neither secret access
  nor provider HTTP may occur after that revocation.
- The private scope chooses only the broker connection name. Raw credentials and
  appHash MUST NOT enter source, manifests, argv, fixture artifacts or reports.
- Connection authentication and real provider results require separately
  authorized operational evidence; the fake HTTP suite does not certify them.

## Console Publication Checks

`src/credentials/inventory-sync.test.ts` and `src/sync/runner.test.ts` MUST prove, each with a mutant that fails it:

- nothing is enqueued without `RAVI_SYNC_CREDENTIALS_INVENTORY=1` (mutants: opt-in removed in the enqueue; env read ignored);
- `storage` survives the sync redactor and no `[REDACTED`, secret value, Vault path, key or actor id appears in the outbox row (mutants: key back to `secret`; raw ref added);
- the payload is a fixed point of `sanitizeSyncPayload`;
- an unchanged inventory waits for the 6 h heartbeat and a change waits 15 min (mutants: heartbeat and throttle removed);
- a linked runner tick enqueues only with the flag (mutant: runner call removed).
- the Vault is asked at most once per 15 min, even when the inventory has not changed (mutant: throttle after the build);
- with the flag off the describer is never called (mutant: opt-in checked after the build);
- a runner tick never waits on the snapshot and starts at most one at a time (mutants: tick awaits; single-flight removed);
- a snapshot that throws synchronously or rejects never stops push and is retried on the next tick (mutant: sync throw escapes);
- person-typed text is capped and token-shaped values are replaced (mutants: purpose or scopes unscrubbed; cap removed).
