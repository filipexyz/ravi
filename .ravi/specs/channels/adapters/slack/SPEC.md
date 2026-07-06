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
