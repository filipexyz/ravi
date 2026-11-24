---
id: sessions/clone
title: Session Clone
kind: capability
domain: sessions
capability: clone
tags:
  - sessions
  - chat-commands
  - channels
applies_to:
  - src/sessions/clone.ts
  - src/cli/commands/sessions.ts
  - src/channels/session-clone-provisioners.ts
  - src/channels/slack/session-clone-provisioner.ts
  - src/chat-commands/engine.ts
  - src/chat-commands/parse.ts
  - src/channels/slack/slash-command-handler.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Session Clone

## Intent

A person copies the session they are in into a new chat with a name they choose: `ravi sessions clone <name>` or `/ravi clone <name>`. The new chat answers with the same agent, in a NEW session that starts from a bounded recap of the origin and then lives on its own. The origin session does not change.

## Commands

- `ravi sessions clone <name> [--session <origin>] [-n <count>] [--invite <ids>] [--execute] [--json]`: dry-run by default (exit 3 with the plan); `--execute` creates the chat, the session and delivers the seed.
- `/ravi clone <name>` (chat command): runs the same runner with `--execute`, inviting the person who typed it.

## Rules

- The core (`src/sessions/clone.ts`) MUST NOT name or import a channel. A channel takes part only through a `SessionCloneProvisioner` it registers; a session whose chat has none MUST be refused with `CLONE_CHANNEL_UNSUPPORTED` before any write.
- Every refusal the caller can fix (`CLONE_NAME_INVALID`, `CLONE_NAME_TAKEN`, `CLONE_ORIGIN_UNBOUND`, `CLONE_CHANNEL_UNSUPPORTED`) MUST happen before the chat is created.
- The name MUST match `^[a-z0-9][a-z0-9_-]{0,79}$` after trimming and lowercasing, and MUST NOT be the name of an existing session.
- The new session MUST run the origin's agent, in the origin agent's cwd, under a session key the router will use for an inbound message in the new chat (the provisioner computes it from the route it just wrote).
- What is copied MUST be what the caller can already read: the origin's recap (`sessions recap`: the last N user/assistant messages, N ≤ 40, each truncated, tools omitted, plus the goal). The CLI MUST refuse an origin the caller cannot access as not found.
- Copied text MUST be masked for credentials (`key=value` secrets, bearer tokens, `rctx_`, Slack, GitHub, OpenAI, AWS tokens, private keys) and MUST be fenced as data, one line per message, so no copied line can start like a system or role marker.
- The seed MUST be delivered as a channel `session.bootstrap` turn with `after_response`. From the CLI it carries the caller's context id, so it can only be narrowed by the caller's turn.
- No grant of the origin chat is copied. The new chat starts with none, so a person turn there gets the minimum (#953) and the asker acts with their own grants.
- `/ravi clone` MUST ask the person for access to the origin session AND for the mutating capability `sessions clone` declares (read from the CLI metadata, as `close` and `stop` do); without that metadata, or with a non-mutating one, it MUST be refused.
- A failure after the chat exists MUST say so (chat id and session name) instead of looking like nothing happened.

## Slack

The Slack provisioner creates a private channel through `slack channels-create --private --agent` (#867), using the origin's Slack account as the channel config, invites only Slack user ids, and refuses a channel it could not route to the agent.
