---
id: channels/adapters/slack
title: "Slack Adapter"
kind: feature
domain: channels
capabilities:
  - slack
tags:
  - socket-mode
  - native-channel
status: active
normative: true
---

# Slack Adapter

## Escopo Inicial

The Slack adapter MUST support:

- Socket Mode connect via `apps.connections.open`;
- envelope ack;
- duplicate envelope detection;
- inbound `message`;
- DM/channel classification;
- thread routing policy;
- outbound text via `chat.postMessage`;
- working presence via temporary reaction on the inbound Slack message;
- delivery event emission.

An eligible Message envelope MUST be persisted in a bounded, secret-redacted
Slack inbox before Socket Mode acknowledgement. Inbox processing MUST use a
leased claim, resume after failure or restart, and treat the backend receipt as
the next durable boundary. Envelope payloads MUST NOT retain verification
tokens, response URLs, or credential material.

Normal admitted Slack messages MUST enter the provider-neutral Channel Backend
after Slack normalization, actor resolution, route selection, canonical
Chat/Message persistence, and thread lifecycle handling. The adapter MUST NOT
publish the ordinary inbound Session prompt as a parallel path. Slack-specific
identity, visibility, routing, thread, file, and policy facts remain adapter
inputs; the backend owns durable ingress receipt, prompt publication claim,
local binding, and runtime correlation.

## Socket Liveness

The adapter MUST verify Socket Mode liveness independently of application
message traffic so a quiet workspace can remain connected without masking a
half-open connection.

For every Socket Mode connection, the adapter MUST:

- require the initial Slack `hello` within a bounded timeout;
- send transport-level WebSocket ping frames on a bounded interval;
- require a matching pong within a bounded deadline;
- terminate and replace the socket when the hello or pong deadline expires,
  without depending on the stale socket to emit `close`;
- reconnect after a socket error even when no later `close` callback arrives;
- rotate the connection when Slack sends a `disconnect` envelope whose reason
  is `warning` or `refresh_requested`;
- ignore late callbacks and timers from a retired socket generation; and
- cancel heartbeat, deadline, and reconnect work during explicit shutdown.
- let explicit shutdown settle without waiting for an in-flight
  `apps.connections.open` request to finish.

The adapter MUST expose live lifecycle state from actual socket events. Calling
`start()` MUST NOT itself mean `connected`; only the active socket's open/hello
lifecycle may establish health. State snapshots MUST distinguish connecting,
connected, and reconnecting, and MUST retain non-secret transition reasons and
timestamps useful for health diagnosis.

## Thread Policy

The adapter MUST distinguish:

- Slack channel as chat container;
- Slack thread as optional thread context;
- Ravi session as runtime state.

Default policy:

- thread replies route by thread;
- replies stay in same thread;
- root messages reply at channel root unless configured otherwise.

Thread replies MUST follow `channels/slack/threads`: a Slack `thread_ts` is a session fork boundary. `route.session` may define the parent/root session, but it MUST NOT collapse thread turns back into that parent runtime session.

## Ignored Events

The adapter MUST ignore:

- hidden events;
- non-message events;
- unsupported subtypes except accepted thread broadcast, file share, and
  admitted bot-message behavior.

## Foreign Bot Intake

Human message admission MUST remain unchanged. Foreign bot messages that pass
the local-identity, installation-visibility, and origin checks below MUST enter
the same route and channel-policy evaluation as human messages. Bot authorship
MUST NOT introduce an additional mention or message-addressing alias requirement.

Before deciding whether to admit any bot-authored message, the adapter MUST use
`auth.test` with that channel account's bot token to discover both the local
`bot_id`, bot `user_id`, and `team_id`, and MUST require `ok=true`. It MUST
prove that the event is visible to that local installation. A matching
`authorizations[].team_id` is positive proof. When the `authorizations` key is
present, it MUST be an array containing at least one clean team id and one value
MUST equal the authenticated `team_id`; empty, malformed, team-less, or
non-matching values MUST fail closed. Slack may truncate the received array to
one representative installation, so a non-match can be a deliberate false
negative. Supporting that case requires full resolution through
`apps.event.authorizations.list`; the adapter MUST NOT treat the received list
as complete or silently fall back. Only when the `authorizations` key is absent
MAY the adapter use the legacy installation proof: the present outer
`payload.team_id` and inner `event.team` values MUST identify one team equal to
the authenticated `team_id`. Missing, conflicting, or mismatched legacy values
MUST fail closed; Ravi's logical account id MUST NOT be substituted as proof.

Resolved origin, `event.source_team`, `event.user_team`, `event.team`,
`payload.team_id`, received authorization team ids, and the local authenticated
team MUST be preserved as separate provenance. `source_team` is the preferred
message-origin value when present;
without it, the present `event.team` / `payload.team_id` values MUST identify one
origin. A bot message with no resolvable origin MUST fail closed. A matching
authorization MAY prove visibility when those outer/inner values differ only if
`source_team` explicitly preserves the origin. It MUST ignore a self message
when either raw event id matches the corresponding local id. A successful
discovery MAY be cached;
concurrent discovery MUST share one in-flight request. Missing, incomplete, or
failed discovery MUST ignore the bot message and MAY use only a bounded failure
backoff before retrying. Discovery itself MUST also have a bounded timeout (five
seconds by default); the underlying HTTP request MUST receive an abort signal,
and a timeout MUST fail closed and MUST release the in-flight slot so a later bot
message can retry. A failure MUST NOT become a permanent cached identity.

An otherwise eligible foreign bot message MUST NOT be dropped because its text
lacks a local-bot mention or begins without an address. Explicit addressing MAY
inform the agent that it was addressed, but MUST NOT be a bot-only admission
gate or bypass normal route/channel policy. There MUST NOT be a separate
message-addressing alias configuration for bot intake. Plain text and multiline
messages MUST preserve their content through the same normalization as human
messages.

Admitted bot messages MUST keep raw `user`, `bot_id`, team, channel, timestamp,
and `senderKind=bot` provenance. The effective sender is raw `user` when present
and otherwise `bot_id`. Both candidate ids MUST be resolved through the same
canonical instance alias contract below, including collision detection and the
exact empty legacy fallback.

The actor MAY be `agent` only when every resolved candidate id belongs to one
and the same agent. Unresolved companion ids do not conflict with that unique
agent. Contact-only identities, an agent/contact mix, multiple agent owners, or
an alias collision MUST resolve to `unknown` with no contact, agent, or platform
identity authority attached. Resolution provenance MUST include the candidate
ids, the matched candidate when successful, and a non-secret bot resolution
reason. A resolved agent actor MUST enter the runtime as the corresponding
`agent:<actorAgentId>` principal; it MUST NOT fall through to `missing_contact`
or erase the executor agent's effective capabilities.

Admission MUST reuse existing route, channel-policy, root/thread, canonical
chat, persistence, and envelope-deduplication behavior. A foreign bot in an
ignored channel or without an eligible route MUST NOT bypass that policy,
whether or not it explicitly addresses Ravi. Root messages MUST follow the
configured root reply policy, and thread replies MUST follow the same configured
subscription/reply policy and session-fork rules as human messages. A duplicate Socket Mode envelope MUST still
produce at most one prompt. Message admission alone MUST NOT grant actor
authority or change the identity-resolution rules above.

## Local Bot Mentions

An admitted human or foreign bot message that mentions the local bot by id
(`<@local_bot_user_id>` or `<@local_bot_user_id|label>`) MUST reach the agent with
a `@mention` marker in the prompt header, and group message context MUST carry
`botTag: "<@local_bot_user_id>"`, so the agent can tell it was addressed. The
group system prompt MUST explain the `@mention` marker whenever `botTag` is
known, whatever the size of the member list. A mention of another user MUST NOT
add the marker.

The local bot user id comes from the same cached `auth.test` discovery used for
bot intake. Human intake MUST NOT wait for it: the adapter starts discovery when
the Socket Mode or gateway service starts, uses the cached identity when present,
and otherwise starts a background discovery (with the same in-flight sharing,
timeout and failure backoff) and admits the message without the marker. A stuck
or failing `auth.test` MUST NOT drop or delay a human message.

## Credentials

The adapter MUST resolve Slack tokens through `src/credentials` unless explicit env fallback is enabled for local smoke.

It MUST NOT log `xapp`, `xoxb`, OAuth secrets, or backend raw secret values.

## Instance Identity Scope

The native adapter MAY address a Slack workspace by its logical account slug while
platform identities for the same workspace may have been stored under the configured
legacy instance UUID (or the exact empty legacy scope). Identity resolution MUST NOT
depend on exact-only lookup against the received value.

The adapter MUST:

- derive a canonical Slack instance reference and its deterministic aliases from
  explicit `RouterConfig`/`ConfigStore` configuration for the same instance, preferring
  the configured instance UUID as canonical when a slug↔UUID mapping exists;
- resolve identities only against the canonical reference, aliases explicitly mapped to
  that same instance, and finally the exact empty legacy scope;
- treat the empty `instance_id` scope as an exact equality only, never as a wildcard, and
  consult it only after every scoped alias misses;
- never resolve a Slack user id from another configured workspace/instance.

When equivalent aliases resolve to different owners the adapter MUST fail closed: it MUST
report reason `ambiguous_instance_alias`, produce no actor and zero capabilities, and MUST
NOT choose the first result by ordering.

Resolution MUST carry structured, non-sensitive provenance including the received alias,
the canonical instance reference, the matched instance scope (when resolved), and a reason
code (`resolved`, `identity_not_found`, or `ambiguous_instance_alias`). Provenance fields
MUST use concrete schemas.

New platform identity and chat/message/participant writes SHOULD use the canonical instance
reference when a configured mapping exists. Existing rows stored under slug, UUID, or the
exact empty legacy scope MUST remain readable without destructive mass migration, and
canonical writes/retries MUST be idempotent and MUST NOT create duplicate platform
identities.

The alias collision check MUST be evaluated before any cached chat-participant fast path.
A participant cached from an earlier, non-conflicting resolution MUST NOT mask a later
slug/UUID owner conflict; such a conflict MUST still fail closed with
`ambiguous_instance_alias`.

Resolved actor attribution and its downstream authority MUST be temporally stable: for an
unchanged agent profile and the same resolved owner, consecutive Slack turns and
turn-context rotations MUST keep `actorResolution=resolved`, the same owner principal, a
non-zero agent-identity capability count, and a non-zero effective capability count. A
genuinely unknown or ambiguous external actor MUST remain fail-closed
(`missing_contact`, zero agent-identity and effective capabilities) across the same
rotations.

## Native Operations

Slack workspace operations MUST follow `channels/slack/operations`.

Agents and operators MUST receive typed Ravi operations such as `slack.channels.list` or `slack.channels.rename`, not raw Slack token access. Mutations MUST default to dry-run and declare permission metadata.

## Delivery Barrier

Normal inbound Slack user messages MUST publish session prompts with `deliveryBarrier=after_tool`.

An admitted foreign bot message MUST use the same delivery barrier because it
is live channel input.

This classifies Slack input as live human conversation, allowing the runtime to interrupt an unrelated active text response after safe tool/compaction barriers. The adapter MUST NOT publish normal user messages as `after_response`, because that can let stale active-turn output reach Slack before the new Slack message is processed.

Generic cross-session, cron, hook, restart, or automation prompts targeting a Slack-backed session MUST keep their own producer defaults, usually `after_response`.

## Presence

The Slack adapter MUST NOT set `suppressPresence` on normal inbound user messages.

Runtime working presence MUST be represented natively by publishing `ravi.channel.presence.slack` and having the channel runner add a temporary configured reaction to the source Slack message.

The default working reaction is `hourglass_flowing_sand`.

The adapter MUST remove the working reaction when the runtime turn reaches a terminal presence event.

Slack typing indicators are not available through Socket Mode or the Web API bot token path. Real Slack typing MAY be added later only as an explicit optional capability backed by an RTM-compatible token/session. If RTM returns `not_allowed_token_type`, the adapter MUST degrade to reaction-based working presence rather than pretending to type.

## Automatic Replies Triggered by Bots

Every eligible foreign bot input MUST continue normal intake and runtime
processing. Output containment MUST NOT introduce a generation quota,
record-only handling, `_skipTurn`, mention/alias requirement or human reset.
It MUST NOT grant tool authority to an unknown bot.

For native-backend turns whose durable canonical ingress has
`rawProvenance.senderKind=bot`, optional commentary MUST be suppressed as a
terminal delivery decision without consuming the terminal allowance. Human
inputs, including actors with unknown identity but `senderKind=user`, MUST
keep their normal streaming and automatic media behavior.

The admission unit is one complete immutable terminal response (final OR
safe-error) for a trusted originating turn and its authorized destination,
including all associated rendered parts and automatic media. A durable
manifest MUST freeze the source, destination, outcome and part fingerprints
before any part is released. All parts MUST share one atomic durable admission
decision. An additional part or changed terminal outcome MUST NOT reuse that
decision. Retries MUST NOT charge the same response again. The existing
renderer and content limits MUST be preserved; there is no new post, file or
byte cap. Optional progress MUST NOT deprive the full final of its allowance.

Canonical part identity MUST derive from the frozen terminal and part position,
not a transient output/publication wrapper or content hash alone. Equivalent
wrappers MUST share the durable send receipt and provider token while retaining
their separate publication identities for audit. Identical content in distinct
parts or a new turn MUST remain distinct. Changed content, destination or bytes
under the same identity MUST fail closed. Media fingerprints MUST cover the
actual file bytes; a fresh upload MUST use the same verified bytes, without
reopening a mutable path after verification. Observed success with a persisted
receipt MUST resume bookkeeping without requiring the original local file.
The manifest is an immutable admission and membership boundary, not a remote
all-or-nothing transaction: a later part failing file verification or delivery
cannot roll back earlier successful Slack posts. Hashing adds work proportional
to attachment size; it MUST NOT introduce a new size cap.
An attachment unavailable at freeze MUST remain an explicit failed member of
that immutable manifest. It MUST NOT prevent projection of the complete text
or delivery of other available members, and appearing later at the same path
MUST NOT reactivate it. No provider success or policy suppression may be
fabricated for that local file failure.

The default policy admits four terminal responses within a rolling five-minute
window for the canonical local installation/account and actual Slack channel.
The next candidate opens a fixed five-minute cooldown. All threads and
sessions in that channel share the state; mentions, sender aliases and new
threads do not reset it. Other accounts/channels have independent state.
These are product defaults, not Slack limits: four permits preserve a small
burst of independent acknowledgements while containing a fast automated
exchange. Suppression can also affect legitimate automatic acknowledgements
in a busy channel; their inputs and processing MUST still continue.

Suppression MUST be terminal and auditable under `channels/delivery`. New
suppressed candidates MUST NOT prolong the deadline. After expiry, only a
response to an input accepted locally after the recovery deadline may obtain
a new permit. Passing time, reconnecting or restarting MUST NOT release old
suppressed output. Existing admitted bundles retain their decision while
completing remaining delivery phases; they do not obtain a fresh allowance.
No Slack notification of suppression or recovery is emitted automatically.

Provenance MUST be validated against the durable backend binding and exact
canonical input, using local `acceptedAt`, not provider timestamps, actor
authority, text similarity or the session's mutable latest source. Automatic
bot media MUST use the same frozen authorized projection destination as the
terminal, including root/thread policy; changing session attach mid-turn
MUST NOT redirect it. Native bot media is deferred until that logical terminal;
human media and explicit tool sends retain their existing paths. Safe-error
and cancellation discard still-deferred attachments rather than releasing
partial work as a later successful terminal.
Pending bot media membership MUST belong to the immutable logical backend
request, not one event-loop invocation or streaming-session object. Replacing
those objects during an in-process provider continuation MUST retain that
membership until the final manifest or logical cancellation closes it. The
pending collection is process-local and partitioned by canonical router
database identity. Reopening the same database connection within that process
MUST retain live request membership; it does not persist descriptors for a
process restart.
Closed or cancelled requests MUST NOT recreate a pending collection or revive
previous members.
Only logical terminal cancellation may freeze a cancelled manifest; a physical
interruption accepted by the existing recovery path MUST NOT add a premature
cancelled-manifest tombstone. This does not expand runtime replay eligibility. Failure in a notification/text sink MUST NOT silently discard media
whose final manifest already froze successfully; their delivery outcomes remain
independent. The separate text outbox and core media path do not guarantee
physical text-before-media delivery order.

The replay-safe session-recovery branch MUST carry its trusted `_channelBackend`
binding explicitly into the restated input, separately from actor authority.
When that branch has accepted continuation of the same request, its failed
physical attempt MUST NOT project a logical terminal failure or freeze a
safe-error manifest before the continuation. The existing physical trace and
replay/provider decisions remain intact. The recovered final MUST retain its
original source, destination and automatic-output policy, including cooldown;
it MUST NOT fall back to unrelated output because recovery lost the binding.
Human bindings in that same branch MUST also remain able to deliver their
legitimate final. Refused recovery and genuinely terminal failure retain their
normal terminal projection; no backend terminal or suppression decision may be
deleted or reopened to make recovery pass.

A recoverable physical interruption MUST defer the logical terminal only when
its effective, currently owned recovery path actually stashes the same accepted
`_channelBackend` envelope and arms continuation. Equality MUST include the full
binding, ingress/correlation identity and frozen destination; a matching turn ID
or an unrelated queued successor is insufficient. Projection and continuation
MUST use that same decision after asynchronous diagnostics, preserving existing
fence/side-effect rules. Explicit cancellation intent MUST win; a physically
closed or internally aborted handle alone is not an explicit cancellation witness.
A physical diagnostic failure before continuation commits MUST retain normal
logical terminal cleanup. A replacement owner MUST NOT be mutated by the old
handler. Ownership validation before a write MUST be pure and repeated after
awaited sinks. A cancelled manifest MUST commit atomically with the logical transition.
Terminal collector cleanup MUST occur only after that commit, before another
await; a rejected transition MUST NOT freeze or clear pending output. These callbacks
are internal runtime capabilities, never accepted from serialized channel/API
envelopes. After permitted replay, the complete final MUST reach the native output
path with coherent logical completion; history alone or absence of `cancelled`
is not proof. Bot cooldown/suppression and human output policy remain unchanged.

For eligible native bot terminals, runtime state and sequence, any canonical
assistant row, and the validated complete terminal manifest MUST share one
synchronous transaction on the same SQLite connection. This applies to complete
text, media-only completion, safe error and logical cancellation. Deterministic
manifest preparation MUST NOT publish, persist, consume pending media or mark
local readiness. Internal ownership predicates MUST remain pure and run within
each existing bounded write attempt before mutation. Identity, transition,
ownership or persistence refusal MUST roll back every new write in that unit
without changing a previously accepted immutable manifest. Manifest schema
initialization MUST NOT cache uncommitted DDL as ready. Only a successful commit
may assign the local manifest/readiness, clear cancelled or failed media, or
discard registry ownership; runtime notifications and output follow that commit.
This atomicity contract adds no delivery retry, availability guarantee after
write retries exhaust, durable media payload or core NATS replay.

The adapter MAY skip reapplying reply-mode policy only for an internal delivery
request derived from a validated manifest and durable origin. An external flag,
copied response hash or nested payload MUST NOT grant that treatment or any
authority. Freezing root/thread projection does not bypass installation or
authorization checks. Deferred media is held in the running logical turn until
the manifest freezes; recovery of attachments lost before that point is not
guaranteed. The compact manifest retains identities and hashes, not file bytes.
Automatic media still travels on the existing core NATS response path, without
a durable media publication outbox or automatic replay into the gateway. A
post-freeze event lost before gateway handling is therefore not guaranteed to
recover either. Restart receipt tests re-present the same payload to prove
safe phase resumption; they MUST NOT imply autonomous recovery of pending media.
Text retains its durable outbound publication/workqueue path.

This bounds admitted logical responses, NOT physical Slack posts, uploads,
bytes, provider retries or their delivery time. Multipart replies remain
complete. A slow bot exchange below the threshold can continue indefinitely;
the policy is volume mitigation, not proof of causal-loop termination.
Separately authorized explicit send tools remain outside this automatic
projection and MUST retain their own authority checks. The circuit MUST NOT
be described as universal protection against tool-driven or slow feedback.
