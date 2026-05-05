---
id: self/commands
title: "Ravi Self Commands"
kind: capability
domain: self
capability: commands
capabilities:
  - self-cli
  - agent-context-cli
tags:
  - self
  - cli
  - agents
applies_to:
  - src/cli/commands/self.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Self Commands

## Intent

`ravi self` is the CLI surface an agent should call before over-reading raw history or asking the user to restate context.

Commands MUST be read-only.

## Command Contract

### `ravi self whoami`

Shows minimal identity:

- agent;
- session;
- runtime context;
- source;
- provider/model metadata;
- current status.

### `ravi self context`

Shows the full self context packet.

Default depth SHOULD be `normal`.

### `ravi self chat`

Shows current chat/conversation context:

- canonical chat id;
- chat type;
- channel/instance;
- participants;
- recent actors;
- unresolved identities;
- provenance/debug ids when requested.

### `ravi self route`

Explains route/session binding:

- matched route;
- route policy;
- priority;
- target agent/session;
- fallback/manual binding reason.

### `ravi self recent`

Shows bounded recent messages/events/signals.

Default SHOULD be small, for example `--limit 10`.

It MUST NOT dump entire session history.

### `ravi self permissions`

Summarizes the current runtime context capabilities.

It MUST NOT print raw context keys.

### `ravi self knowledge`

Shows relevant knowledge threads/context packets for the current session/chat/task/project.

It MUST degrade gracefully when Knowledge is unavailable.

### `ravi self explain`

Explains how Self resolved the packet:

- context source;
- session lookup;
- chat binding;
- route match;
- identity resolution;
- permissions;
- omitted or unauthorized sections.

## Common Flags

Commands SHOULD support:

```bash
--json
--session <session-key>
--agent <agent-id>
--depth compact|normal|full
--limit <n>
--debug-provenance
```

Explicit `--session` and `--agent` lookups MUST be permission checked.

## Human Output

Human output SHOULD show next useful commands.

Example:

```text
Ravi Self

Agent: dev
Session: dev
Source: whatsapp group -> chat:...
Route: group:* -> dev
Work: task-...
Knowledge: runtime-session-pool

Next:
  ravi self recent --limit 10
  ravi self route
```

## JSON Output

JSON output MUST include:

- typed sections;
- missing data;
- unauthorized data;
- provenance/debug only when requested or safe;
- next read commands.

## Acceptance Criteria

- Every command is safe to call from an agent runtime.
- Every potentially large command is bounded by default.
- Every command supports `--json`.
- No command mutates state.
- Commands expose Ravi semantics first and raw transport ids only as provenance/debug.
