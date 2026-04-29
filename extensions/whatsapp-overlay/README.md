# Ravi WhatsApp Overlay

Unpacked Chrome extension for `web.whatsapp.com` that overlays Ravi session state on top of the current chat.

## Product Loop

The extension is the surface; the gateway is the source of truth. UI decisions graduate from "preview" to "product" inside the extension itself.

Current chosen direction: a compact status rail (`quiet rail`) below the conversation app bar.

## Current Surfaces

What already exists in code:

- chat-list badges for visible rows (`session + live state`)
- message-level chips inside the conversation timeline
- compact `quiet rail` below the conversation app bar
- v3 placeholder layer driven by extension-local state
- chat → session binding via `chat.bindSession`, persisted in `chrome.storage.local`

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

The extension consumes the Ravi gateway directly via `@ravi-os/sdk`. No local bridge.

1. Open `chrome://extensions`
2. Enable `Developer mode`
3. Click `Load unpacked`
4. Select this folder: `extensions/whatsapp-overlay`
5. Open the extension options page and add a server: paste the gateway base URL plus a context key issued by `ravi context issue`. The active server is persisted in `chrome.storage.local`.

## Current v0

- floating Ravi pill
- in-page drawer
- live detector for current WhatsApp Web screen with rolling logs
- extension publishes the current view-state to local storage; placeholders read it back
- snapshot resolution by `chatId`, `session`, or `title` via parallel SDK calls
- real actions: `abort`, `reset`, `set-thinking`
- a floating "recent agents" navigation stack was tested and explicitly rejected in favor of a future right sidebar

## Limitations

- the first cut prefers stability over deep DOM anchoring
- chat correlation falls back to title matching when `chatId` is not discoverable from the page
- routing/config actions are intentionally out of scope for the first test
- current cross-chat navigation is not yet product-grade; the chosen next direction is a dedicated right sidebar
