# Ravi v3 CLI Stream Core

## Purpose

This document is the canonical source of truth for the Ravi v3 transport core.

It replaces scattered status spread across chat history, brainstorm notes, and ad-hoc comments.

Use this file to answer:

- what the v3 core is
- what has already been built
- what is explicitly not built yet
- what the next integration step is

## Thesis

Ravi v3 should treat the CLI stream as the canonical transport boundary for server-driven widgets and overlays.

The system is intentionally split into four layers:

1. `CLI stream`
   - emits JSONL over stdout
   - accepts commands over stdin
2. `Local relay/runtime`
   - starts and supervises the CLI child
   - keeps snapshot cache and cursor
   - correlates command `ack/error`
   - fans out reduced state to browser consumers
3. `Overlay/widget runtime`
   - declarative renderer only
   - no direct NATS, secrets, or business logic
4. `Site adapter`
   - maps DOM surfaces, anchors, and context

## Canonical Protocol

Transport:

- `stdio`
- `JSONL`
- one JSON object per line

Envelope types:

- `hello`
- `snapshot`
- `event`
- `command`
- `ack`
- `error`
- `heartbeat`

Shared fields:

- `v`
- `id`
- `ts`
- optional `cursor`
- `body`

This protocol is terminal-debuggable by design and can also be carried remotely over `ssh` without turning the browser into the transport owner.

## Current Implementation

As of `2026-03-29`, wave 1, the placeholder consumer slice, the first minimal action, and the first useful widget mutation already exist in the repo:

- `src/stream/protocol.ts`
  - typed protocol schemas
- `src/stream/server.ts`
  - `ravi stream` JSONL stdio server
- `src/stream/relay.ts`
  - local relay abstraction with snapshot cache and command correlation
- `src/stream/protocol.test.ts`
- `src/stream/relay.test.ts`
- `src/cli/index.ts`
  - top-level `ravi stream` command
- `extensions/whatsapp-overlay/lib/dom-model.js`
  - placeholder snapshot built from extension-local view-state and a minimal component map
- `extensions/whatsapp-overlay/background.js`
  - handlers for `ravi:get-v3-placeholders` and `ravi:v3-command`
  - composes snapshots via parallel `@ravi-os/sdk` calls (`sessions.list`, `tasks.list`, `routes.list`)
- `extensions/whatsapp-overlay/content.js`
  - browser consumer for placeholder mode
- `extensions/whatsapp-overlay/styles.css`
  - placeholder layer visuals

Validated behaviors:

- `ravi stream --scope events` emits `hello`
- `stdin command ping` returns `ack`
- `stdin command snapshot.open` emits `snapshot`
- relay reaches `running`, stores `hello/snapshot`, resolves `ping`, and rejects `fail`
- the extension renders a placeholder layer from view-state persisted in `chrome.storage.local`
- `chat.bindSession` is handled inside the service worker and persisted to `chrome.storage.local.ravi_overlay_bindings`

## What Is Not Built Yet

Not built yet:

- real widget state patches driven by the new transport
- full replay semantics beyond best-effort cursor

## Next Milestone

The next correct milestone is:

`move from one useful widget mutation to broader product state on the new transport`

That means:

1. keep placeholder mode as the mapping proof
2. keep `placeholder.outline` as the minimal proven action
3. keep `chat.bindSession` as the first useful state mutation
4. port the next mutation after bind (`migrate session` or `create session`)
5. stop letting the new transport be "mapping + one bind"

## Explicit Non-Goals

Not part of this core document:

- widget library design
- product polish of the WhatsApp overlay
- approval flow
- full REBAC surface
- voice agent experiments

## Related Documents

- `../../ravi/main/.genie/brainstorms/site-overlay-platform/DRAFT.md`
- `../../ravi/main/.genie/wishes/ravi-v3-cli-stream-core/WISH.md`
- `docs/whatsapp-overlay-status.md`
