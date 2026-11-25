---
id: credentials/broker
title: "Credential Broker"
kind: capability
domain: credentials
capabilities:
  - broker
tags:
  - secrets
  - keychain
  - vault
  - approval
  - audit
  - controls
applies_to:
  - src/credentials/broker.ts
  - src/credentials/backends
  - src/cli/commands/credentials.ts
  - pocs/credential-broker
owners:
  - rbbt-credentials
status: active
normative: true
---

# Credential Broker

## Intent

The credential broker is the boundary that turns an authorized provider action
request into a provider call using a secret that is never returned to the
caller.

The broker protects provider secrets from agents, chats, generic CLIs, logs and
audit surfaces while still allowing Ravi to perform approved external actions.

## Invariants

- The broker MUST be the only generic component that resolves provider secret
  values.
- The broker MUST NOT expose a user-facing command that prints or returns a
  provider secret.
- The broker MUST load connection metadata before resolving a secret.
- The broker MUST load lifecycle metadata before resolving a secret.
- The broker MUST reject disabled, missing or mismatched connections before
  resolving a secret.
- The broker SHOULD reject expired connections before resolving a secret.
- The broker MUST check `use:credential:<provider>:<connection>` before
  resolving a secret.
- The broker MUST check `execute:<provider>:<action>` before resolving a secret.
- The broker MUST request approval for sensitive actions before resolving a
  secret.
- The broker MUST write audit events without secret values.
- Provider adapters MUST receive secrets only inside the broker operation
  boundary.
- Provider adapters MUST return redacted action results.
- Backend adapters MUST return typed/redacted errors.
- Vault backend writes MUST preserve sibling keys at the same KV v2 path.
- Vault production writes SHOULD use KV v2 CAS/version checks.
- Keychain production writes MUST NOT pass secret values through process
  arguments.
- `broker exec --dry-run` MUST NOT resolve secrets.
- Public connection serialization MUST redact sensitive parts of secret refs.
- Public connection serialization SHOULD expose a stable `secretRefAlias` or
  redacted ref, not raw Vault paths by default.
- Successful broker use SHOULD update `lastUsedAt` without storing secret
  material.

## Consumption Authority

- Every secret resolution MUST enforce the two capabilities through the
  Permission Provider Runtime. Command authorization alone is insufficient.
- Runtime callers MUST resolve their explicit key or in-process context against
  the current persisted context and executor. Invalid, expired, revoked or
  missing contexts MUST NOT fall back to a default credential or local operator.
- The issued capability snapshot and current executor ceiling MUST both cover
  the request. Provider denial or `needs_approval` MUST stop before backend read.
- Sensitive runtime actions MUST obtain operation approval without adding a
  capability grant. After waiting, the broker MUST revalidate caller, current
  permissions, provider decision and unchanged active connection before reading.
- Exception, the author's own turn: a non-destructive sensitive action MAY
  skip the approval card, and MUST then be audited with
  `approval_status = actor_authorized` and `approval_required = 1`, only when
  all of these hold for the invoking context:
  - the provider is `slack` (the only provider whose actions are classified;
    every other provider keeps the card);
  - `turnProvenance.origin` is `human` (a message a person sent; cron,
    trigger, observer and other automation turns never qualify);
  - `actorResolution` is `resolved` and `actorPrincipal` is `contact:<id>`;
  - `actorProjection` is absent (a thread acting for its parent never
    qualifies);
  - the contact exists, is not `blocked` and has not opted out;
  - the contact's own materialized capabilities allow both
    `use:credential:<provider>:<connection>` and `execute:<provider>:<action>`.
  The agent's own context MUST still pass every check above this exception;
  the exception removes only the card that would ask the author to approve
  their own request.
- Destructive actions MUST always obtain operation approval, including on the
  author's own turn. An action is destructive when either:
  - its last dotted segment is `archive`, `kick`, `delete` or `remove` (for
    example `conversations.archive`, `conversations.kick`, `chat.delete`,
    `canvases.delete`, `canvases.access.delete`, `reactions.remove`,
    `pins.remove`, `bookmarks.remove`); or
  - its caller passes `destructive: true` to the broker because the method
    name hides a removal. Callers MUST set it for every change that removes
    existing content. Today: `ravi slack canvas-edit` with `operation =
    delete`, or with a `replace` that has no section id (the whole previous
    body is gone), both sent as `canvases.edit`; and the whole-canvas
    publishers `canvas-showcase`, `canvas-channel-showcase` and
    `canvas-artifact-publish` (always `replace`).
  Ordinary writes: a section `replace`, `rename` and inserts on
  `canvases.edit`, and `chat.update` (its payload always carries non-empty
  text and validated blocks, so it cannot empty a message).
- An approval refusal MAY reach the caller as `detail` only when it is fixed
  text the approval service wrote for that request
  (`isFixedApprovalRefusalReason`). Exception messages and a rejecting
  person's words MUST NOT leave the broker.
- Read-only actions do not require operation approval: `auth.check`,
  `auth.test`, `whoami`, `blocks.validate`, `canvases.sections.lookup`,
  `channels.list`, `channels.info`, `conversations.list`,
  `conversations.info`, `conversations.history`, `conversations.replies`,
  `conversations.members`, `users.list`, `users.info`, `users.lookupByEmail`,
  `users.conversations`, `team.info`. Every other
  action is sensitive.
- Known limitation: the exception reads the author's subject capabilities
  (`materializeSubjectCapabilities("contact", id)`), not grants scoped to a
  chat. An author who holds the action only through a chat-scoped grant keeps
  the approval card. This is deliberate: falling back to the card is the safe
  side, and lending a chat-scoped grant to a credential that acts outside that
  chat would widen it.
- Accepted risk: reads skip the card per action, not per channel. Any
  channel the bot can read is readable without a card once the agent holds
  the read action.
- Accepted risk: content read during a human turn (a message, a canvas) can
  steer the agent into a non-destructive write the author holds, such as
  `conversations.invite`, `canvases.access.set` or `chat.postMessage`, without
  a card. The author asked in that turn and holds the action; destructive
  actions still ask.
- Follow-up: the `actor_authorized` audit row records the actor context and
  agent but not the contact that authorized it; the contact is recoverable
  through `actor_context_id` (context metadata `actorPrincipal`) while the
  context exists. Recording `contact_id` needs a credentials-DB column
  migration and is deferred.
- Reads that still ask: `files.list` and `slack.topology` are read-only but
  stay sensitive. The topology exposes Ravi's internal state (agent ids,
  session keys, routes, policy) and lists DMs; `files.list` enumerates files
  per channel and per person. Lending either to a cron, a trigger or a relay
  without a card is not worth it; on the author's own turn they follow the
  write exception like any other sensitive action.
- Every action `src/cli/commands/slack.ts` sends to the broker MUST be listed
  in `src/cli/commands/slack-credential-actions.test.ts` with its class
  (read, write or destructive) and its number of call sites. The test reads
  the TypeScript AST of `slack.ts` (comments and strings never count) and
  guarantees:
  - every call to `createSlackOpsContext`, `this.mutationOpsContext`,
    `this.mutationCredentialContext`, `resolveSlackCredentialContext` and
    `resolveSlackCredentialConfigFromEnv` is either one of the four known
    forwarding calls inside those helpers, with its arguments pinned as
    source text, or a classified site; any other call fails;
  - every identifier spelling one of those five names is its single
    declaration (or the import of `resolveSlackCredentialConfigFromEnv`) or
    the callee of a direct call (`name(...)` or `this.name(...)`); an alias,
    another receiver, `.bind`/`.call` or passing the function as a value
    fails;
  - the object passed to `this.mutationOpsContext` and
    `this.mutationCredentialContext` has no spread; every property is
    written in the call;
  - none of the five entry points is exported or re-exported from
    `slack.ts`, and `mutationOpsContext` and `mutationCredentialContext` are
    `private`, so no other file can reach the broker through them;
  - a site's action is a string literal, a conditional of string literals, or
    a `const` in the same function initialized to one of those; anything else
    fails;
  - the number of sites per action, and in total, equals the table exactly;
  - the broker's class (`explainCredentialPolicy`, `isDestructiveAction` and
    the site's `destructive` mark) equals the table for every site;
  - `destructive` is read only as a top-level property of the call's object
    literal; the three whole-canvas publishers carry the literal `true`, and
    the only non-literal mark is `isSlackCanvasRemovalChange(change)` on
    `canvases.edit`.
  It does not cover, by design:
  - Slack calls outside `slack.ts` (socket mode and delivery use
    internal-service authority and never show the card);
  - an entry point reached through a computed or string key
    (`this["mutationOpsContext"](...)`), which is not an identifier;
  - mutation of the argument after it is built (assigning `input.action` or
    `input.destructive` before or inside the forwarding call), which the AST
    of the call site does not show.
  Code review owns these; the test does not claim them.

- Trusted host entrypoints MAY explicitly select operator-control for direct
  local operator commands or named Slack infrastructure services. Internal
  service authority MUST be limited to its provider/action allowlist, MUST NOT
  be accepted from command arguments and MUST NOT override an active runtime
  invocation. Missing context alone MUST NOT authorize secret access.
- Local CLI provenance MUST distinguish a default credential loaded for
  convenience from an explicit runtime caller. A scoped default MUST NOT turn
  explicit host bootstrap into an agent invocation, and an invalid explicit
  key MUST NOT fall back to that default.
- Approval-card finalization MUST use the host delivery boundary instead of
  recursively consuming credentials under the waiting agent's context. That
  boundary MUST derive targets, terminal state and grant outcome from persisted
  approval records, never arbitrary text or destinations from an event payload.
- Audit MUST distinguish denied authorization, pending provider approval,
  operation approval, the author's own turn (`actor_authorized`) and explicit
  operator-control. It MUST NOT manufacture an
  `allow` decision or retain backend exceptions that could contain plaintext.
- The current diagnostic `broker exec` MUST remain `@CliOnly` until it executes
  a real provider adapter. This fix does not make it a generic agent tool.

## Broker Flow

1. Resolve caller context from `RAVI_CONTEXT_KEY`.
2. Load connection metadata by provider and connection id.
3. Explain required capabilities.
4. Authorize credential usage.
5. Authorize provider action execution.
6. Request approval if required.
7. Resolve the secret through the configured backend.
8. Execute the provider adapter.
9. Clear secret material from local scope as soon as possible.
10. Persist audit event.
11. Return action result without secret material.

## Backend Contract

Backend adapters MUST implement this internal shape:

```ts
interface CredentialSecretBackend {
  kind: "file" | "keychain" | "vault";
  write(input: SecretWriteInput): Promise<SecretRef>;
  read(ref: SecretRef): Promise<string>;
  delete(ref: SecretRef): Promise<boolean>;
}
```

The `read` method is internal only. It MUST NOT be exported as a public CLI
command or SDK endpoint.

Backends MAY also describe a secret without reading it
(`describeSecret(ref)` in `src/credentials/backends.ts`):

- Vault uses only the KV v2 metadata endpoint (`GET <mount>/metadata/<path>`)
  and returns version, created/updated times and whether the current version
  is deleted or destroyed. It MUST NOT call the data endpoint, and a refusal
  (403 `forbidden`, 503 `sealed`, network `unreachable`, missing
  `VAULT_ADDR`/`VAULT_TOKEN` `not_configured`, other `error`) MUST degrade to
  `{ available: false, reason }` with a fixed reason. It never throws and never
  falls back to a data read.
- Backends without metadata (`file`, `keychain`) return
  `{ available: false, reason: "unsupported" }`, which is not a degradation.

## Inventory

`ravi credentials connections inventory --json` (and
`buildCredentialInventory()`) is the metadata-only snapshot that the Console
shows. It MUST:

- list every connection, active and disabled, up to 500;
- carry lifecycle metadata (`owner`, `purpose`, `rotatedAt`, `expiresAt`,
  `disabledAt`), `lastUsedAt` and the backend description;
- name each secret by `secretRefAlias` = `<backend>:<provider>:<connection>`,
  never by the backend coordinate (no Vault path, no key, no keychain account);
- derive `lastUsedAt` from the audit trail (latest `secret_resolved`), so the
  broker hot path writes nothing extra and cannot race the `updated_at` that
  its host guard compares;
- include at most 200 recent audit rows without `actorContextId` or `agentId`;
- set `degraded: true` with sorted `degradedReasons` when a backend refuses
  metadata, and still return every item.

`expiresAt` is recorded and shown; the broker does not yet deny an expired
connection (the SHOULD in the invariants above stays open).

### Console publication

The daemon publishes the inventory through the Console sync bridge
(`src/credentials/inventory-sync.ts`, called from the sync runner tick):

- It is opt-in: only with `RAVI_SYNC_CREDENTIALS_INVENTORY=1` (in addition to
  `RAVI_SYNC_RUNNER_ENABLED=1` and a Console login). Without the flag nothing
  is built or enqueued. Existing installations keep their egress unchanged.
- Event: domain `credentials`, type `credentials.inventory`, entity
  `credential_inventory/installation`, payload schema `credentials.inventory/v1`.
  A snapshot is split into pages of at most 48 KiB of UTF-8 JSON (the Console
  rejects a sync payload over 64 KiB): every page carries `snapshotId` (the
  content hash), `page`, `pages` and the header; page 1 carries the audit. The
  Console shows a snapshot only when it holds all `pages` of one `snapshotId`.
  Pages are sized after the sync redactor, as the outbox stores them. Page 1
  MAY carry the audit with no item, when the first item does not fit beside
  it; an audit too large for a page alone loses its oldest entries. A
  connection sends at most 50 scopes (the rest become one `+N more` entry) and
  every audit string is capped like free text, so one item always fits. A page
  over the limit is never emitted: the build fails instead. The content hash
  includes the wire format, so the first check after an upgrade from the
  unpaged format publishes instead of waiting for the heartbeat.
  Every string is bounded to what the Console schema accepts (identifiers
  100, `id` and other text 200, alias 250), since the Console drops a whole
  page over any bound; a cut never splits a surrogate pair. The bounds MUST be
  the last thing that touches a string: the payload is built as the wire
  shape, then the sync redactor (which lengthens text, "Bearer x" becoming
  "Bearer [REDACTED]"), then the bounds, so the redactor the outbox runs again
  on every page finds nothing left to change.
- The payload is the inventory with each item's `secret` renamed `storage`:
  the sync redactor blanks every key ending in "secret". The payload MUST be a
  fixed point of `sanitizeSyncPayload` (nothing for the redactor to remove) and
  MUST NOT contain a secret value, Vault path, key or actor id.
- The inventory is built (and the Vault asked) at most every 15 minutes: the
  throttle runs before the build, on a check cursor written before it, so a
  failing build also waits. A change goes up at the next check; an unchanged
  inventory goes up every 6 hours as a heartbeat. The hash ignores
  `generatedAt`.
- The runner starts the snapshot in the background, one at a time: push and
  pull of every domain never wait on the Vault, and a throw or rejection is
  logged with `sanitizeSyncError` and retried on a later tick.
- Person-typed text (`label`, `owner`, `purpose`, `scopes`) is capped (200 and
  100 characters) and token-shaped values (Vault/OpenBao, Slack, GitHub,
  `sk-`, AWS key ids, JWTs, any unbroken run of 40+ key characters) are
  replaced with `[redacted]` before the payload is built. These fields are
  visible to the Console; the Console MUST render them as plain text.

The default `file` backend MUST keep secret bytes in broker-owned private files
(0700 directory, 0600 files) with atomic writes and strict opaque references.
It is plaintext protected by the host account and works on headless Linux;
Keychain and Vault remain explicit alternatives. The backend MUST reject unsafe
paths, links and permissions rather than expose the secret through an error.

## Provider Adapter Contract

Provider adapters SHOULD implement a narrow action executor:

```ts
interface CredentialProviderActionAdapter {
  provider: string;
  execute(input: {
    connection: CredentialConnectionRecord;
    action: string;
    secret: string;
    params: Record<string, unknown>;
  }): Promise<CredentialActionResult>;
}
```

Provider adapters MUST NOT store the secret value. They MAY return provider
metadata, status, ids and redacted errors.

## CLI Contract

`ravi credentials` SHOULD expose:

```text
ravi credentials connections list
ravi credentials connections show
ravi credentials connections inventory
ravi credentials connections add
ravi credentials connections remove
ravi credentials connections rotate
ravi credentials policies explain
ravi credentials broker exec
```

CLI commands MUST use:

- `@Group`
- `@Command`
- `@CommandAccess`
- `@Returns`
- standard pagination with `nextCommand` (except `inventory`, a bounded snapshot of at most 500 items)

`broker exec` MAY exist for testing and first integrations. It MUST behave as a
brokered action entrypoint, not as a generic secret-read command.

## Audit Contract

Audit events MUST include:

- provider
- connection
- action
- actor/context id when available
- agent/session when available
- capability decision
- approval requirement/status
- backend kind
- secret ref alias or redacted coordinate
- result status
- redacted error code/message

Audit events MUST NOT include:

- provider secret values
- authorization headers
- Vault tokens
- raw backend response bodies
- request bodies containing secrets
- chat prompt text containing secrets

## Validation

- `bun test pocs/credential-broker/broker.test.ts`
- When implemented: `bun test src/credentials/**/*.test.ts`
- When implemented: `bun test src/cli/commands/credentials.test.ts`

## Known Failure Modes

- `broker exec` becomes a secret oracle by returning the resolved secret.
- `--dry-run` resolves the secret accidentally.
- Sensitive action asks for approval after secret resolution.
- Authorization checks only action permission and forget credential usage.
- A provider adapter logs request headers with bearer tokens.
- Vault delete removes an entire shared path instead of only the configured key.
- Keychain adapter uses a PoC-safe implementation in production.
- Connection metadata stores a real token because `secretRef` validation is too
  loose.

## Additional native action guards

Native integrations MAY supply an in-process `beforeResolve` callback. It MUST
run after any operation approval and before backend secret access. It is an
additional restriction, never an authorization override; no CLI/gateway input
may provide it. After it awaits, the broker MUST revalidate current caller,
capabilities and the unchanged active connection before reading the secret.

A provider integration MAY declare its read-only actions with
`registerProviderReadOnlyActions(provider, actions)`, from its own packaged
catalogue and keyed by provider: one provider's declaration never marks another
provider's action as a read. The Omie executor declares exactly the read entries of
its catalogue. Channel reads the broker already knows (such as
`conversations.members`) stay in its own list.
Neither method name patterns nor client-declared `mutating` flags may downgrade
a provider write.
