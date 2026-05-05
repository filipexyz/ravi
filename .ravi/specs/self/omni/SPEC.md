---
id: self/omni
title: "Self Omni Bridge"
kind: capability
domain: self
capability: omni
capabilities:
  - omni-context-bridge
  - transport-provenance
tags:
  - self
  - omni
  - channels
  - chats
applies_to:
  - src/omni
  - src/router
  - src/cli/commands/self.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Self Omni Bridge

## Intent

The Self Omni Bridge defines how `ravi self` uses Omni-derived data without leaking Omni as the product model.

## Boundary

Omni owns transport:

- raw inbound events;
- raw channel ids;
- native message ids;
- provider delivery state;
- attachments and transport metadata;
- native capabilities when needed.

Ravi Self owns orientation:

- current agent/session;
- canonical chat;
- actors;
- route;
- permission context;
- relevant work/knowledge.

## Projection Rule

`ravi self` MUST project Omni data through Ravi semantic records:

```text
Omni raw event
  -> Ravi chat
  -> platform identity
  -> contact|agent actor
  -> route/session binding
  -> self context packet
```

If a semantic record is missing, Self MUST show the gap.

It MUST NOT silently fall back to treating raw Omni ids as canonical product ids.

## Debug Provenance

Raw Omni ids MAY appear when:

- `--debug-provenance` is set;
- an operator is debugging routing/transport;
- no canonical mapping exists yet and the output labels it as unresolved provenance.

Raw ids MUST NOT be shown as the primary answer in default agent-facing output.

## Channel Capabilities

Self MAY expose normalized channel capabilities when they affect what the agent can do.

Examples:

- reactions supported;
- media outbound supported;
- edits supported;
- voice/audio supported;
- thread/topic supported.

Omni SHOULD remain the source of transport capability facts.

## Failure Modes

Self must make these states explicit:

- chat not bound to session;
- participant identity unresolved;
- route matched by fallback;
- raw provider id known but canonical chat missing;
- transport capability unknown;
- Omni unavailable while Ravi semantic context still exists.

## Acceptance Criteria

- A WhatsApp-originated self context shows Ravi `chat` first.
- A raw JID/LID appears only under provenance/debug by default.
- If chat binding is missing, Self tells the agent what diagnostic to run.
- Self does not query Omni directly from random feature code; access stays behind adapter/service boundaries.
