# WhatsApp Overlay Status

## Purpose

This document is the canonical source of truth for the WhatsApp Overlay state.

It consolidates:

- current product direction
- what is already validated
- what is still pending
- which experiments were explicitly rejected or removed

## Current Product Direction

The overlay is no longer treated as a one-off WhatsApp hack.

It is now the first live proving ground for the Ravi v3 model:

- site adapter
- anchor mapping
- server-driven UI
- local relay/control plane
- terminal-first inspection and debugging

Product surfaces currently matter in this order:

1. chat-list chips
2. conversation rail/context
3. message-level artifacts
4. session workspace
5. Omni workspace

## Validated Reality

The following are already validated in browser and terminal:

- `inspect == UI`
  - visible chat rows, matched session, status, unread
- chat-list chips
  - session + state correlation on visible rows
- right-side cockpit shell
  - session-centric direction is defined
- session workspace
  - a session can now replace only the center pane, while the Ravi drawer stays visible
  - it no longer depends on the currently open WhatsApp chat
  - it already supports prompt send directly to the selected session
- message artifacts
  - interruption/tool artifacts can be injected inline
- DOM control plane
  - CLI can inspect, inject, outline, and remove DOM on demand
- v3 placeholder substrate
  - relay-fed placeholder state is available in the bridge and terminal
  - the browser now has a first placeholder layer for mapped anchors
  - the first real action is live: clicking a placeholder outlines its mapped slot through `command -> ack/error`
  - the first useful widget mutation is also live: `bind existing session` now goes through `/v3/command` as `chat.bindSession`

## Current Technical Shape

Today the overlay runs in a hybrid state:

- `content.js`
  - DOM mapping, product rendering, and placeholder consumer
  - plus the new center-pane session workspace renderer and composer
- `background.js`
  - thin bridge proxy
- `src/whatsapp-overlay/bridge.ts`
  - read model + actions + live state reduction
  - plus session-workspace read + prompt endpoints
  - plus v3 placeholder endpoint and first v3 command endpoint backed by the local relay
- `src/whatsapp-overlay/cli.ts`
  - terminal inspection/control plane
  - plus `placeholders`, `placeholders-outline`, and `bind` for the v3 mapping/control surface
- `src/stream/*`
  - new transport core already live underneath the placeholder slice

This means the transport swap has started and now includes one real widget action plus one real widget state mutation, but product state still mostly rides the old bespoke bridge.

## Chosen Direction

The chosen next direction is:

`continue replacing bespoke overlay transport with the new Ravi v3 CLI stream + relay model`

That means:

- keep the current product surfaces
- keep growing the new session workspace as the primary session-centric center pane
- keep placeholder mode as the proof of mapped anchors
- use the proven placeholder action plus `chat.bindSession` as the template for the next real widget mutation

## Pending Work

The open items that still matter:

- browser validation of cockpit v1 RBAC/Omni cut
- final live validation of artifact anchoring by message identity
- validate placeholder mode visually in the extension after reload
- port the next higher-value action/state mutation through the v3 command path after `bind existing session`
- decide whether approval enters now or after transport swap

## Explicitly Rejected / Removed

Rejected:

- floating recent-agent navigation near the app bar
  - wrong navigation model

Removed:

- experimental overlay voice slice
  - not part of the current overlay direction
  - not a source of truth anymore

## Related Documents

- `docs/whatsapp-overlay-cockpit-v1.md`
- `docs/whatsapp-overlay-rbac.md`
- `docs/whatsapp-overlay-manual-checklist.md`
- `docs/whatsapp-overlay-cockpit-v1-browser-validation-2026-03-28.md`
- `docs/ravi-v3-cli-stream-core.md`
