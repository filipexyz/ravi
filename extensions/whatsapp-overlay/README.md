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

## Limitations

- the first cut prefers stability over deep DOM anchoring
- chat correlation falls back to title matching when `chatId` is not discoverable from the page
- routing/config actions are intentionally out of scope for the first test
