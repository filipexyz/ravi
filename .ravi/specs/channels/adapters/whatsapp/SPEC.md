---
id: channels/adapters/whatsapp
title: "WhatsApp Adapter (ravi channels runner)"
kind: feature
domain: channels
capabilities:
  - whatsapp
tags:
  - baileys
  - native-channel
applies_to:
  - src/channels/whatsapp/
  - src/channels/inbound/
  - src/channels/outbound/
  - src/channels/group-metadata/
  - src/channels/account-resolution.ts
  - src/daemon-channels.ts
  - src/cli/commands/instances.ts
status: active
normative: true
---

<!-- markdownlint-disable-next-line MD025 -->
# WhatsApp Adapter (ravi channels runner)

## Scope

WhatsApp is a first-class Ravi channel. Omni is never on the WhatsApp path.

- The Baileys sockets MUST live in the `ravi channels` runner (PM2 process
  `ravi-channels`), one runtime per enabled `channels` row with provider
  `whatsapp`.
- Inbound events MUST reach the daemon as Ravi-owned `WhatsAppInboundEvent`
  envelopes (`src/channels/whatsapp/events.ts`) on the `CHANNEL_INBOUND`
  JetStream stream. The daemon reads them with `WhatsAppInboundSource`
  (`src/channels/whatsapp/inbound-source.ts`) and hands them to the shared
  `ChannelInboundPipeline` (`src/channels/inbound/pipeline.ts`).
- Outbound and control calls MUST go over the WhatsApp RPC (schema version 2,
  `src/channels/whatsapp/contract.ts`) through `WhatsAppClient`
  (`client.ts`) and `WhatsAppSender` (`sender.ts`). In the daemon,
  `WhatsAppSender` sits behind the default-deny `ChannelSenderRouter`
  (`src/channels/outbound/router.ts`).
- WhatsApp code MUST NOT import `src/omni/**` or `src/omni-config.ts`.
  `src/channels/import-boundary.test.ts` enforces it: no static non-type
  import edge from `src/channels/**`, `src/gateway.ts`, `src/daemon.ts`,
  `src/daemon-channels.ts`, `src/cli/commands/{group,instances,media,image,audio}.ts`
  or `src/cli/media-send.ts` reaches those files, and a dynamic `import(` into
  them exists only on the non-WhatsApp branch of `src/daemon-channels.ts`,
  `src/cli/commands/instances.ts` and `src/cli/media-send.ts`.
- Omni stays an optional legacy bridge for Telegram/Discord only
  (`src/omni/legacy-bridge.ts`, `OmniLegacyInboundSource`, `OmniSender`).

`src/daemon-channels.ts` composes both: one `ChannelInboundPipeline`, the
WhatsApp source always, the Omni source only when the bridge is configured,
and `createChannelSenderRouter({ whatsapp, bridge })`. Sources start in
parallel (`Promise.allSettled`); a failing source does not block the other.

## Deviation From The Channel Backend Invariant

`channels` requires every native provider to enter Session/Turn execution
through the provider-neutral Channel Backend. WhatsApp is an explicit
exception:

- inbound MUST go through `ChannelInboundPipeline`, which publishes the
  ordinary session prompt (the same pipeline the legacy bridge uses);
- the runner MUST NOT call `host.ingress` / `acceptChannelIngress`, and its
  driver MUST declare only the `inbound` capability;
- outbound text MUST use the gateway's direct delivery path through the
  sender router (synchronous message ids, TTS, contact bookkeeping, typing
  renewal), not the `CHANNEL_OUTBOUND` work queue.

The exception MUST end when the Channel Backend supports agent debounce,
gateway text delivery (outbound mention resolution, TTS, contact interaction,
presence renew) and the edit-restart flow for backend-owned turns; the adapter
then moves to `acceptResolvedChannelIngress` like Slack. No other provider MAY
cite this exception.

## Ownership And Identity

- A `channels` row with provider `whatsapp` binds the Ravi instance whose
  `instances.name` equals the channel name, or `defaults.instance` when set
  (`listWhatsAppBindings`, `resolveWhatsAppBinding`). A disabled or deleted
  channel row binds nothing; `findWhatsAppChannelForInstance` also finds
  disabled rows (used by `instances enable/disable` and provisioning).
- The channel name MUST pass `ChannelBackendOpaqueIdSchema`. When the
  instance name does not, `whatsappChannelNameFor` derives a sanitized name
  (fallback `whatsapp-<first 8 chars of the UUID>`, suffixes `-2`, `-3`, …)
  and the instance name goes to `defaults.instance`.
- The transport instance id MUST be `instances.instance_id`, a UUID. A new
  instance mints one with `crypto.randomUUID()`; an existing UUID (for example
  one created under Omni) MUST be kept. The channel name MUST NOT be used as a
  transport instance id.
- `instances create/connect` MUST provision the instance and its channel row
  together through `ensureWhatsAppInstance`
  (`src/channels/whatsapp/provisioning.ts`), in one router-DB transaction. It
  refuses a soft-deleted instance name, a non-WhatsApp instance, a disabled
  bound channel and a same-named WhatsApp channel bound to another instance,
  before any write.
- On first open of an existing router DB, `backfillWhatsAppInstancesToChannels`
  creates the channel row (and mints a missing UUID) once for every
  non-deleted canonical-WhatsApp instance (router_meta
  `whatsapp_channels_backfill_v1`). The row is enabled when the instance is
  enabled.
- WhatsApp's channel-type id stays `whatsapp-baileys` (`WHATSAPP_CHANNEL_TYPE`,
  named after the Baileys implementation): `ChannelInboundEvent.channelType`,
  `MessageTarget.channel`, `sessions.last_channel` and idempotency keys use it,
  and session keys strip `-baileys`.
- `isWhatsAppChannelType` (canonical `whatsapp`, `whatsapp-baileys`,
  `whatsapp baileys`) is the only WhatsApp type Ravi serves.
  `isWhatsAppFamilyChannelType` also matches any type containing `whatsapp`
  (`twilio-whatsapp`, `whatsapp-cloud`, …) and `gupshup`; those
  non-canonical types are unsupported in every direction.
- `message.received` payloads keep their field shapes: `from` is the bare
  sender id (no `@domain`), `chatId` is the canonical LID-first JID,
  `rawPayload` is the WAMessage plus the extended fields.
- Outbound message ids returned by the RPC MUST be Baileys `key.id`.

## Inbound Contract

- The runner MUST publish with `publishWhatsAppInboundEvent` on stream
  `CHANNEL_INBOUND` (subjects `ravi.channel.inbound.>`, limits retention, file
  storage, 7 days), subject
  `ravi.channel.inbound.whatsapp.<kind>.<instanceId>` with
  `kind` ∈ `message`, `reaction`, `connection`, and the event `id` as
  JetStream `msgID` so redeliveries collapse in the duplicate window. Message
  and reaction ids are deterministic
  (`whatsapp-baileys:<instanceId>:<externalId>:<kind>`).
- The envelope MUST validate against `WhatsAppInboundEventSchema`:
  `{schemaVersion: 1, id, instanceId, timestamp, receivedAt?, type,
  ingestMode (message.received only), payload}`. Published types:
  `message.received` (including edits and deletes), `reaction.received`,
  `connection.qr`, `connection.connected`, `connection.disconnected`. Other
  runtime observations (typing, unread counters, sync progress, delivery
  receipts, `reaction.removed`) MUST NOT be published.
- Both the runner (before its first publish) and the daemon MUST create the
  stream and the durables `ravi-whatsapp-messages`, `ravi-whatsapp-reactions`
  and `ravi-whatsapp-connection` (`ensureChannelInboundStream`,
  `AckPolicy.Explicit`, `DeliverPolicy.New`, one filter subject per kind), so
  process start order never loses events.
- `WhatsAppInboundSource` MUST drop, with a warning, an envelope that fails the
  schema or whose subject instance or kind does not match the envelope. On
  start it deletes the PR #590 durables `ravi-native-*` best effort.
- History sync MUST be published with `ingestMode: "history-sync"`. Baileys
  offline backlog (`append`) MUST be age-aware: `history-sync` when the
  message is older than `offlineStaleMs` (channel `defaults.offlineStaleMs`,
  default 10 minutes) or has no usable timestamp, otherwise `realtime`.
  `defaults.offlineIngestMode` forces one mode. The pipeline MUST still
  persist chat, message, participant and contact for history-sync events and
  MUST NOT prompt an agent.
- The legacy bridge source (`OmniLegacyInboundSource`) MUST drop every Omni
  event whose channel type is WhatsApp-family (`whatsapp-baileys`,
  `whatsapp`, `twilio-whatsapp`, `gupshup`, …), bound or not, logging
  "Ignoring Omni event for a WhatsApp channel type; migrate with ravi
  instances connect" once per instance.

## Pipeline Behaviour

- Session keys, route matching, DM/group detection, LID canonicalisation,
  contacts, chats, mentions, the history ledger, reactions
  (`ravi.inbound.reaction`), unknown-instance handling
  (`ravi.instances.unregistered`) and the prompt envelope MUST be the same for
  WhatsApp and the legacy bridge: both run the one pipeline instance.
- WhatsApp hooks: media from the runner's local files, group metadata over the
  `groups.metadata` RPC, cached in `channel_group_metadata`.
- `connection.qr` and `connection.connected` MUST be relayed as
  `ravi.whatsapp.qr.<uuid>` and `ravi.whatsapp.connected.<uuid>` (payload
  `channelType: "whatsapp-baileys"`), and connected MUST register the agent's
  platform identity. Legacy-bridge channels use `ravi.bridge.qr|connected.<uuid>`.
- The edit-restart notice the agent sees MUST be headed
  `## Mensagem editada detectada pelo canal`; `src/runtime/session-rebase.ts`
  accepts it and the older `## Mensagem editada detectada pelo Omni`.
- Provenance of new WhatsApp rows uses the transport id `whatsapp`
  (`whatsapp.message.received`, `whatsapp.reaction.received`,
  `whatsapp.instance.connected`, link reason `whatsapp_instance_connected`).

## Media

- The runner MUST download inbound media itself to
  `<RAVI_STATE_DIR>/media/whatsapp/<instanceId>/<YYYY-MM>/<id><ext>` and set
  `content.mediaUrl = file://<abs>` and `content.localPath = <abs>`.
- The daemon MUST read that media from disk only under `<RAVI_STATE_DIR>/media`
  after resolving symlinks, with the shared size limits. WhatsApp media is
  never fetched over HTTP.
- Outbound media and stickers MUST be sent by absolute `filePath` (no base64).
  `WhatsAppSender` and `ravi media send` resolve a relative path against their
  working directory first.

## RPC (schema version 2)

- Only the runner holds sockets. Daemon, gateway and CLI MUST reach it over
  NATS request/reply on `_RAVI.channels.whatsapp.rpc.<instanceId>`, queue group
  `ravi-whatsapp-rpc`.
- Requests MUST be `{protocol: "ravi.channels.whatsapp.rpc", schemaVersion: 2,
  requestId, instanceId, method, params}` and be validated with
  `WhatsAppRpcRequestSchema` plus the per-method params schema on both sides. A
  request with another schema version MUST fail with 400 `INVALID_REQUEST`, so a
  runner and a daemon from different bundles fail loudly.
- Methods: `connection.status|connect|disconnect|logout|pairingCode`,
  `groups.list|create|addParticipants|updateParticipants|getInvite|revokeInvite|join|leave|rename|setDescription|setSettings|metadata`,
  `messages.sendText|react|delete|edit|sendMedia|sendSticker|markRead`,
  `presence.set`.
- Responses MUST be `{ok: true, requestId, data}` with exactly the
  `WhatsAppRpcResults[method]` shape, or
  `{ok: false, requestId, error: {status, code, message, retryAfterMs?}}`.
  `groups.list` MUST stay under the NATS payload limit: over ~900 KB it empties
  every `participants` array and sets `participantsTruncated: true`.
- Error statuses MUST stay HTTP-like: `INVALID_REQUEST` 400, `NOT_FOUND` 404,
  `PAIRING_REQUIRED` 409, `RATE_LIMITED` 429 (with `retryAfterMs` when the
  runtime knows its backoff), `TRANSPORT_ERROR` 502, `NOT_CONNECTED` 503.
  Client side (`WhatsAppRpcError`): no responders is 503
  `WHATSAPP_RUNNER_UNAVAILABLE` (the message names `ravi channels start`), a
  timeout is 504 `WHATSAPP_RPC_TIMEOUT`, a malformed reply is 502
  `WHATSAPP_RPC_INVALID_RESPONSE`, and a ref that is not bound to an enabled
  WhatsApp channel fails with 404 `WHATSAPP_NOT_BOUND` before any request.

## Outbound Routing

- `ChannelSenderRouter` MUST deny by default (`classifyInstanceRoute`):
  - a WhatsApp binding or a canonical-WhatsApp instance record goes to
    `WhatsAppSender` (unbound: 404 `WHATSAPP_NOT_BOUND`);
  - a WhatsApp-family record that is not canonical fails with 422
    `CHANNEL_PROVIDER_UNSUPPORTED`;
  - any other instance record goes to the legacy bridge sender, or fails with
    503 `LEGACY_BRIDGE_NOT_CONFIGURED` when Omni is not configured;
  - a ref with no instance record (for example an unmapped UUID) fails with 404
    `INSTANCE_NOT_FOUND`.
- A WhatsApp instance and an unknown instance MUST never reach the bridge.
  Account resolution (`src/channels/account-resolution.ts`) follows the same
  rule and never passes an unmapped UUID through.
- `WhatsAppSender` retries (3 attempts, 1s/2s, honouring `retryAfterMs`) only
  when the request certainly did not send: 503 `WHATSAPP_RUNNER_UNAVAILABLE`
  (no responders), 503 `NOT_CONNECTED`, 429 `RATE_LIMITED`. Text, media and
  stickers MUST NOT be retried on 504 or 502 (ambiguous outcome); reactions,
  edits and deletes also retry on any 5xx. `sendTyping` and `markRead` never
  throw.

## Pairing And CLI

- `ravi instances connect <name>` is always served by the runner (there is no
  `--transport` option and no `whatsapp.transport` setting). It provisions the
  instance and channel row, emits `ravi.config.changed`, retries the
  `connection.status` / `connection.connect` RPC for up to 15 s while the
  runner hot-adds the channel, subscribes to the QR/connected topics before
  the connect RPC, and prints QR codes until the phone links (120 s).
  `--json` returns on the first QR code. Pairing needs both the runner and the
  daemon running.
- `connection.connect` MUST reconnect when stored creds exist and otherwise
  open a socket that produces QR codes.
- `ravi instances disconnect <name>` sends `connection.disconnect`. The runtime
  MUST persist a manual-disconnect marker: it does not auto-connect on runner
  restart or config reconcile (health `disconnected` / `manual_disconnect`)
  until `connection.connect` (or a pairing-code request) clears it. A
  disconnect issued while Baileys is still loading MUST be honoured.
- `ravi instances logout <name> --execute` sends `connection.logout` (wipes
  the creds; unlinks the device only when the runtime is connected); without
  `--execute` it is a dry-run (exit 3). The result carries `unlinked` (true
  only when the unlink request went out); the CLI MUST NOT claim an unlinked
  device otherwise and MUST tell the operator to remove it on the phone
  (WhatsApp > Linked devices). When the runner does not answer it wipes the
  creds locally.
  `ravi instances delete <name>` also logs out (runner, else local wipe)
  before the soft delete, and MUST then disable the instance's WhatsApp
  channel (before `ravi.config.changed`) so the runner stops it instead of
  failing an unbound start. `ravi instances restore <name>` MUST set the
  channel back to the restored instance's `enabled` state.
- `ravi instances enable|disable <name>` MUST also set `channels.enabled` on
  the instance's WhatsApp channel: disable stops the runtime and keeps the
  creds, enable starts it again.
- `instances connect|create|disconnect|status` MUST reject a non-canonical
  WhatsApp-family channel type with `USAGE_ERROR` before any RPC or bridge
  call.

## Auth State

- Auth state MUST live in its own SQLite file
  `<RAVI_STATE_DIR>/whatsapp/auth.db` (directory 0700, files 0600, WAL,
  `busy_timeout` 250 ms), opened only by the runner and explicit CLI helpers
  (`clearWhatsAppAuthState`). Tables: `whatsapp_auth_state` (`instance_id`,
  `key`, `value`, `updated_at`, primary key `(instance_id, key)`),
  `whatsapp_instance_state` (manual-disconnect marker), `whatsapp_auth_meta`.
- Rows of the older router-DB table `whatsapp_auth_state` in `ravi.db` MUST be
  copied once (marker `router_db_copy_v1`); the old table is never written.
- Writes go through a write-behind queue: one transaction per `keys.set`,
  failed writes stay dirty and retry with jittered backoff (250 ms doubling to
  30 s), and runtime stop flushes the queue. A 401 `loggedOut` MUST clear the
  instance's auth state.

## Single Socket Owner

- Exactly one process MUST hold the Baileys socket of an instance: the
  `ravi-channels` runner. `ravi channels probe` MUST NOT open WhatsApp sockets.
- Two runners on the same router DB and NATS MUST NOT run at once; the runtime
  MUST NOT reconnect after a 440 `connectionReplaced`, which is the symptom.
- An instance moved from Omni MUST be disconnected on Omni first
  (`omni instances disconnect <uuid>`).

## Runner Lifecycle And Health

- `start()` MUST NOT block on the network: with creds (and no manual-disconnect
  marker, `defaults.autoConnect` not false) it connects in the background;
  without creds it reports health `starting` with reason `pairing_required`
  and waits for a connect RPC.
- Health MUST map the socket state: `connected`, `starting`
  (`pairing_required`, `qr_pending`), `reconnecting`, `disconnected` (with the
  reason, e.g. `manual_disconnect`, `logged_out`, `connection_replaced`,
  `qr_reset_failed`), and `failed` (`missing_dependency` when Baileys cannot be
  loaded, `startup_failed`). Unpaired enabled instances keep the runner in
  `starting`.
- A failing async Baileys listener or QR-cycle reset MUST be caught and
  surfaced as health, never crash the runner (which also hosts Slack); the
  runner logs stray `unhandledRejection` / `uncaughtException`.
- On `ravi.config.changed` the runner MUST start runtimes for newly added or
  enabled WhatsApp channels and stop removed or disabled ones without a runner
  restart.
- The runner is not started by `ravi daemon start`; WhatsApp needs
  `ravi channels start`.

## Packaging

- Baileys is a vendored, patched tarball (`vendor/baileys/`) and MUST be
  committed. It is a build-time devDependency; the published package MUST NOT
  declare a `file:` dependency.
- No Ravi source file MAY import a runtime value from `"baileys"` (type imports
  only). `src/channels/whatsapp/baileys-loader.ts` (`loadBaileys()`,
  `baileys()`) loads `dist/vendor/baileys.js` next to the running bundle, or the
  bare package in a source checkout; a failed load is retried on the next
  connect.
- The CLI MUST be a single-file bundle (no `--splitting`); `build:vendor`
  bundles `vendor/baileys-entry.ts` into `dist/vendor/baileys.js`, which only the
  runner loads. The CLI and the daemon never load Baileys.
