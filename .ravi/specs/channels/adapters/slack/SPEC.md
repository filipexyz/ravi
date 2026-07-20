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

- bot messages;
- hidden events;
- non-message events;
- unsupported subtypes except accepted thread broadcast behavior.

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

This classifies Slack input as live human conversation, allowing the runtime to interrupt an unrelated active text response after safe tool/compaction barriers. The adapter MUST NOT publish normal user messages as `after_response`, because that can let stale active-turn output reach Slack before the new Slack message is processed.

Generic cross-session, cron, hook, restart, or automation prompts targeting a Slack-backed session MUST keep their own producer defaults, usually `after_response`.

## Presence

The Slack adapter MUST NOT set `suppressPresence` on normal inbound user messages.

Runtime working presence MUST be represented natively by publishing `ravi.channel.presence.slack` and having the channel runner add a temporary configured reaction to the source Slack message.

The default working reaction is `hourglass_flowing_sand`.

The adapter MUST remove the working reaction when the runtime turn reaches a terminal presence event.

Slack typing indicators are not available through Socket Mode or the Web API bot token path. Real Slack typing MAY be added later only as an explicit optional capability backed by an RTM-compatible token/session. If RTM returns `not_allowed_token_type`, the adapter MUST degrade to reaction-based working presence rather than pretending to type.
