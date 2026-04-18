# Ravi WhatsApp Overlay

Unpacked Chrome extension for `web.whatsapp.com` that overlays Ravi session state on top of the current chat.

## Product Loop

The overlay now follows a two-step loop:

1. `ravi-overlay` CLI + local bridge act as the prediction/control plane.
   We use them to inspect the live DOM, resolve stable anchors, and prototype UI directly in the open WhatsApp tab.
2. Once a pattern proves useful, we materialize it inside the extension itself.

This keeps exploration fast and cheap:

- the CLI can probe, inject, outline, and remove DOM nodes on demand
- the extension keeps publishing live state from the page
- stable UI decisions graduate from "preview" to "product"

Current chosen direction: a compact status rail (`quiet rail`) below the conversation app bar, validated first through the CLI before baking it into the extension surface.

## Current Surfaces

What already exists in code:

- chat-list badges for visible rows (`session + live state`)
- message-level chips inside the conversation timeline
- compact `quiet rail` below the conversation app bar
- local bridge + CLI for DOM inspection, preview injection, and live state resolution
- first v3 placeholder layer fed by `relay + published DOM map`
- first real v3 action: clicking a placeholder outlines the mapped slot through `command -> ack/error`
- first useful v3 mutation: binding the current chat to an existing session now goes through `chat.bindSession` on the same command boundary

These surfaces work as a product lab:

- the left pane proves session correlation at scale
- the center pane proves message enrichment and per-chat context
- the placeholder layer proves mapped anchors before richer widgets
- the CLI keeps us from hardcoding UI too early

## Navigation Lessons

One experiment was intentionally useful even though it was rejected:

- a floating stack of "recent agents" below the rail

It proved that Ravi can surface cross-chat context inside WhatsApp, but it also showed the wrong product model for navigation:

- the item was `agent-centric`, while navigation in WhatsApp is always `chat-centric`
- clicking only worked well when the target row was already visible in the native chat list
- the stack competed with the app bar instead of extending WhatsApp's navigation model

So the lesson is now explicit:

- `agent` is metadata
- `chat` is the navigation entity

## Target Direction

The next cockpit cut should stop treating navigation as a floating overlay and instead materialize a real right-hand Ravi sidebar:

- left: native WhatsApp chat list
- center: native WhatsApp conversation
- right: Ravi sidebar, visually aligned with the left pane

That sidebar should be:

- `chat-centric`
- searchable
- deterministic to open
- good for operational scanning

Reference spec:

- [`docs/whatsapp-overlay-cockpit-v1.md`](../../docs/whatsapp-overlay-cockpit-v1.md)
- Canonical current status:
  - [`docs/whatsapp-overlay-status.md`](../../docs/whatsapp-overlay-status.md)
- Canonical next substrate:
  - [`docs/ravi-v3-cli-stream-core.md`](../../docs/ravi-v3-cli-stream-core.md)

## Run

1. Start the local bridge:

```bash
bun run wa:overlay:bridge
```

Optional CLI inspector:

```bash
bun run wa:overlay:cli current
bun run wa:overlay:cli watch
# or
./bin/ravi-overlay current
```

2. Open `chrome://extensions`
3. Enable `Developer mode`
4. Click `Load unpacked`
5. Select this folder: `extensions/whatsapp-overlay`

## Current v0

- floating Ravi pill
- in-page drawer
- live detector for current WhatsApp Web screen with rolling logs
- extension publishes the current WhatsApp Web view-state to the local bridge
- `ravi-overlay current/watch` reads the latest published state from the terminal
- `ravi-overlay dom ...` can inspect and manipulate the live WhatsApp DOM for anchored UI experiments
- snapshot resolution by `chatId`, `session`, or `title`
- live activity states from NATS (`thinking`, `compacting`, `awaiting approval`)
- real actions: `abort`, `reset`, `set-thinking`
- app-bar UI is currently being prototyped through the CLI first, with `quiet rail` selected as the first persistent pattern to materialize
- a floating "recent agents" navigation stack was tested and explicitly rejected in favor of a future right sidebar

## Limitations

- the first cut prefers stability over deep DOM anchoring
- chat correlation falls back to title matching when `chatId` is not discoverable from the page
- routing/config actions are intentionally out of scope for the first test
- current cross-chat navigation is not yet product-grade; the chosen next direction is a dedicated right sidebar
