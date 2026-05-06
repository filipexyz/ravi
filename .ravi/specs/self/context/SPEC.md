---
id: self/context
title: "Self Context Packet"
kind: capability
domain: self
capability: context
capabilities:
  - self-context-packet
  - current-session-orientation
tags:
  - self
  - context
  - runtime
  - sessions
applies_to:
  - src/cli/commands/self.ts
  - src/runtime/context-registry.ts
  - src/sessions
owners:
  - ravi-dev
status: draft
normative: true
---

# Self Context Packet

## Intent

The self context packet is the normalized shape returned by `ravi self context`.

It is designed to fit inside an agent's working prompt without becoming a transcript dump.

## Required Sections

### `identity`

Who is asking.

Fields SHOULD include:

- `agentId`
- `sessionKey`
- `contextId`
- `contextKind`
- `runtimeProvider`
- `runtimeModel`
- `source`

### `conversation`

Where the interaction is happening.

Fields SHOULD include:

- `chatId`
- `chatType`
- `channel`
- `instanceId`
- `threadId`
- `sessionChatBinding`
- `originMessageId`

Raw platform ids belong under `provenance`.

### `actors`

Who is involved.

Fields SHOULD include:

- current requester;
- current agent;
- recent speakers;
- resolved contacts;
- resolved agents;
- unresolved platform identities;
- actor confidence/provenance.

### `route`

Why this session received the prompt.

Fields SHOULD include:

- matched route pattern;
- target agent;
- target session;
- route policy;
- priority;
- fallback/manual-binding reason.

### `work`

Operational work context.

Fields MAY include:

- task;
- project;
- workflow;
- todo list;
- command invocation;
- artifact lineage.

### `knowledge`

Semantic context.

Fields MAY include:

- matching knowledge thread;
- relevant summaries;
- decisions;
- open loops;
- risks;
- last signal.

### `permissions`

What the current context can do.

Fields SHOULD summarize:

- allowed capability families;
- denied or absent capability families;
- scoped objects;
- approval requirements.

Context keys MUST NOT be printed.

### `recent`

Bounded recent context.

Fields SHOULD include compact recent messages/events/signals with limits and truncation metadata.

## Missing Data

Every optional section MUST be able to express:

- `missing`: the data does not exist yet.
- `unknown`: the data could not be resolved.
- `unauthorized`: the current context cannot read it.
- `unavailable`: the backing service is down or not implemented.

Agents must be able to recover without guessing.

## Prompt Size

Default packet size SHOULD be small.

The command MAY support:

```bash
--depth compact|normal|full
--limit <n>
--include recent,knowledge,permissions
--debug-provenance
```

`full` MUST still be bounded unless a separate explicit all-time flag exists.

## Acceptance Criteria

- Packet can be rendered as compact human text.
- Packet can be emitted as typed JSON.
- Packet exposes canonical Ravi concepts first.
- Packet separates semantic fields from provenance/debug fields.
- Packet marks missing/unauthorized data explicitly.
