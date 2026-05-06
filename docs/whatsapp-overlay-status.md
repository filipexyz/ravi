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
- task visibility in the drawer
  - active tasks can now be inspected from the extension itself
  - selected tasks show instructions, assignment and recent event timeline without leaving WhatsApp Web
- message artifacts
  - interruption/tool artifacts can be injected inline
- DOM control plane
  - CLI can inspect, inject, outline, and remove DOM on demand
- v3 placeholder substrate
  - extension reads view-state from `chrome.storage.local` and renders placeholders for mapped anchors
  - widget mutation: `bind existing session` is persisted via `chat.bindSession` into `chrome.storage.local.ravi_overlay_bindings`

## Current Technical Shape

The overlay consumes the Ravi gateway directly via `@ravi-os/sdk`. There is no local bridge.

- `content.js`
  - DOM mapping, product rendering, and placeholder consumer
  - center-pane session workspace renderer and composer
  - read-only task list/detail surface in the drawer
- `background.js`
  - service worker; routes UI requests to `@ravi-os/sdk` (HTTP transport against the active gateway from `chrome.storage.local.ravi_auth`)
  - composes snapshots locally from `sessions.list` + `tasks.list` + `routes.list` + bindings
- `lib/compositions.js`, `lib/storage.js`, `lib/dom-model.js`
  - extension-side helpers replacing the former bridge composition layer
- `lib/sdk/*`
  - vendored `@ravi-os/sdk` client (HTTP transport) bundled with the extension

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
