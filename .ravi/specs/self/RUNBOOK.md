---
id: self/runbook
title: "Ravi Self Runbook"
kind: domain
domain: self
status: draft
normative: false
---

# Ravi Self Runbook

## Inspect Current Context

```bash
ravi self whoami
ravi self context
```

Use this when an agent is confused about where a prompt came from.

Expected output:

- agent id;
- session key;
- context id;
- source type;
- chat/session binding if present;
- linked work and knowledge if present.

## Inspect Chat and Actors

```bash
ravi self chat
```

Use this when the agent needs to know who is in the conversation.

Check:

- canonical chat id;
- chat type;
- participants;
- actor metadata;
- unresolved platform identities;
- raw ids only under provenance/debug.

## Inspect Route

```bash
ravi self route
```

Use this when a prompt arrived unexpectedly or the wrong agent handled a chat.

Check:

- matched route;
- route policy;
- route priority;
- target agent/session;
- channel/account/instance;
- fallback reason.

## Inspect Recent Context

```bash
ravi self recent --limit 10
```

Use bounded recent context instead of reading an entire transcript.

The default MUST be safe for large sessions.

## Inspect Permissions

```bash
ravi self permissions
```

Use this before attempting tools or proposing actions.

The output should summarize capability families and explicitly show absent capabilities.

It must not expose raw context keys.

## Inspect Knowledge

```bash
ravi self knowledge
```

Use this when the agent needs semantic context rather than recent transcript.

Expected output:

- linked knowledge threads;
- relevant summaries;
- confidence/evidence hints;
- next deeper `ravi knowledge` commands.

## Diagnose Missing Context

If self output is empty or weak:

1. Check `ravi context whoami`.
2. Check whether the session has a chat binding.
3. Check route resolution.
4. Check message actor metadata.
5. Check whether Knowledge has ingested the thread.
6. Check permissions.

## Diagnose Raw Omni Leakage

If a self command exposes raw channel ids as primary fields:

1. Confirm whether a canonical chat/contact/platform identity exists.
2. If yes, fix self projection to show Ravi ids first.
3. If no, mark raw ids under `provenance` and expose the missing canonical mapping.
4. Do not build feature behavior on raw ids.
