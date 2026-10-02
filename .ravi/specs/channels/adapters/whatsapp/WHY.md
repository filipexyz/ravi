# Why WhatsApp Is A First-Class Ravi Channel

Omni is a separate service (API, Postgres, its own NATS streams) that Ravi
installed and supervised only to hold WhatsApp sockets. Every WhatsApp turn
depended on that second runtime staying healthy, and most WhatsApp fixes landed
in another repository. The owner's requirement was to remove the Omni
dependency for WhatsApp completely. The Baileys socket now lives in the
`ravi channels` runner, reusing the same patched Baileys build and the fixes
Omni carried (write-behind key store, LID-first sender keys, decrypt-failure
tracking, echo suppression, edit dedupe, reconnect rules).

## Why A Ravi-Owned Contract

The first native version (PR #590) published Omni's envelope under an Omni
subject and kept an Omni-shaped routing client, so "native" WhatsApp still
spoke Omni on the wire and fell back to Omni for anything it did not own.
WhatsApp now has its own contract: `ravi.channel.inbound.whatsapp.<kind>.<uuid>`
subjects with a versioned `WhatsAppInboundEvent` envelope, and an RPC with
WhatsApp method names (schema version 2, so a runner and a daemon from different
bundles fail loudly instead of misbehaving). The payload fields did not change,
so session keys, chats, contacts, prompts and the existing pipeline tests keep
proving behaviour.

## Why One Shared Inbound Pipeline

`ChannelInboundPipeline` is the only implementation of session keys, contacts,
chats, mentions, edit-restart and the history ledger. WhatsApp and the legacy
bridge both feed the same instance through their own sources, so behaviour
cannot fork, and the history cutoff, reaction dedupe and active-target map stay
process-global as before.

## Why Not The Channel Backend (Yet)

The Slack adapter enters through the Channel Backend, and the `channels`
invariant asks the same of every native provider. Doing that for WhatsApp now
would change runtime semantics that WhatsApp users rely on:

- backend-owned prompts carry an isolated turn envelope, which turns off agent
  debounce batching and native-steer injection and terminalizes coalesced
  prompts as interrupted;
- backend-owned turns skip gateway text delivery, losing outbound `@mention`
  resolution, the TTS emit, contact interaction records and presence renewal;
- the edit-restart flow needs the in-process daemon session, which the runner
  does not have;
- approvals need the synchronous message id of the direct send path.

Porting those behaviours into the backend is a separate project. Until then the
deviation is written down in the spec with its exit condition so it does not
become precedent for other providers.

## Why Default-Deny Outbound

The gateway's direct send paths resolve an account to an instance id and pass an
unknown UUID through. With a routing client that sent "everything not native" to
Omni, a typo or an unmapped UUID silently went to the bridge. The sender router
now answers each case explicitly: WhatsApp goes to the runner, an unbound
WhatsApp instance fails with `WHATSAPP_NOT_BOUND`, a record-less ref fails with
`INSTANCE_NOT_FOUND`, and only Telegram/Discord records reach the bridge.

## Why Omni WhatsApp Events Are Dropped

An account served by both Omni and the runner is two linked devices delivering
every message twice. Dropping every WhatsApp-family event from the bridge,
bound or not, removes that failure mode and the ownership checks it needed.
`twilio-whatsapp` and `gupshup` only ever worked through Omni; the runner speaks
Baileys only, so those types are unsupported rather than half-served.

## Why Ownership Comes From The Channel Row

Ownership has to be decided in three processes (runner, daemon, gateway/CLI)
from the same data. Deriving it from the existing `channels` and `instances`
tables means there is no extra flag to drift, a config change is one
`ravi.config.changed` away from every process, and `channels.enabled` stays the
runner's on/off switch (`instances enable/disable` toggle both rows).

Keeping the instance UUID as the transport id is what makes migration lossless:
sessions, chats, platform identities and `RAVI_INSTANCE_ID` values written under
Omni stay attached when the instance moves.

## Why Auth State Has Its Own File

The auth state holds the linked device's private keys and is written on every
message. In the shared router DB, daemon or CLI write locks could stall the
runner or lose signal keys. A dedicated `auth.db` (0600, WAL) opened only by the
runner, with a retrying write-behind queue, keeps key writes durable and
isolated.

## Why A Single Socket Owner

WhatsApp allows one live session per set of credentials. A second socket with
the same creds (a probe runner, a second host, a stale process, Omni) triggers
`connectionReplaced` and both sides fight. Keeping sockets only in the runner,
skipping them in `channels probe`, and never reconnecting after a replace keeps
the failure visible instead of flapping.

## Why A Vendored Baileys Bundle

The patched Baileys is a local `file:` tarball. A published package that
declares a `file:` dependency cannot be installed with `bun add`, so the tarball
is a build-time input. Code splitting kept Baileys out of the CLI start path but
left ~30 chunk files that a global `ravi update` deleted under running
processes. Baileys is now bundled once into `dist/vendor/baileys.js` and loaded
at run time by the runner only, and the CLI is a single file again.
