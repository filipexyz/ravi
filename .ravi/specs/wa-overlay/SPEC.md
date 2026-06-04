---
id: wa-overlay
title: WhatsApp Overlay
kind: domain
domain: wa-overlay
capabilities:
  - auth
  - migration
  - voice
tags:
  - extension
  - whatsapp
  - overlay
applies_to:
  - extensions/whatsapp-overlay
owners:
  - ravi-dev
status: draft
normative: true
---

# WhatsApp Overlay

## Intent

The WhatsApp overlay is the browser extension control surface for operating Ravi while the user is inside WhatsApp Web.

It MUST communicate with Ravi through the SDK/gateway contract and the active context key model defined by `wa-overlay/auth`.

## Boundary

The overlay owns:

- compact WhatsApp Web UI integration;
- local browser storage for overlay UI preferences and active gateway selection;
- SDK calls to Ravi gateway;
- display of chat/session/agent state;
- browser-only media capture when a feature such as voice requires it.

The overlay does NOT own:

- Ravi session identity;
- chat identity or participants;
- agent routing;
- provider API keys;
- tool execution;
- backend persistence.

## Invariants

- The overlay MUST NOT store provider API keys.
- The overlay MUST use the active gateway/context-key entry from `wa-overlay/auth`.
- The overlay MUST NOT create parallel local state that becomes source of truth for sessions, chats, agents, or voice sessions.
- The overlay SHOULD keep controls compact and avoid replacing WhatsApp Web primary layout unless explicitly toggled.
- Provider-specific UI labels SHOULD be presentation only; backend decisions MUST use Ravi semantic ids and transport ids.
