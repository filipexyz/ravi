# WhatsApp Overlay Vibes Runbook

## Inspect Event Sources

Use gateway streams for implementation testing and NATS replay for backend debugging.

Live session stream through CLI:

```bash
bin/ravi events stream -f "ravi.session.*"
```

Session replay when debugging a missed transition:

```bash
bin/ravi events replay --stream RAVI_EVENTS,MESSAGE,REACTION,SYSTEM --session <session> --since 30m --json
```

Relevant source files:

- `src/sdk/gateway/streaming/channels.ts`
- `extensions/whatsapp-overlay/lib/sdk/streaming.js`
- `extensions/whatsapp-overlay/lib/live-state.js`
- `extensions/whatsapp-overlay/lib/live-state-model.js`

## Validate Mapping

1. Pick one selected session in the overlay.
2. Open the session stream with `stream.session(sessionName, { timeout: 0 })` or the broader `events` stream already used by live state.
3. Send a prompt to the session.
4. Confirm these transitions:
   - `prompt.received` -> `thinking`
   - `tool start` -> `tooling`
   - `tool end` -> `thinking` or `failed`
   - `stream`/`response` -> `responding`
   - `turn.complete` or `silent` -> `idle`
   - `turn.failed` -> `failed`
5. Confirm text-bearing fields are ignored by the audio message layer.

## Debug No Audio

Check in order:

1. Operator enabled vibes through a user gesture.
2. Browser did not block `AudioContext` start.
3. The active gateway server exists in `chrome.storage.local.ravi_auth`.
4. Gateway stream connects without 401/403.
5. The selected session name matches the stream topic parser.
6. Mute and volume preferences are not suppressing output.
7. The page is not in a hidden/paused state.
8. Console has no CSP or sandbox errors.

## Debug Excessive Audio

Check:

1. Accent cooldowns for `stream`, `presence.typing`, and repeated `dispatch.queued`.
2. Whether both broad `events` and per-session streams are active for the same session.
3. Whether old streams were aborted on active server/session changes.
4. Whether terminal events fade the state layer to idle.

## Strudel Spike Procedure

Only use this procedure when the `wa-overlay/vibes/strudel` gate is explicitly enabled.

1. Bundle Strudel packages locally. Do not load JS from `unpkg`, `jsdelivr`, `strudel.cc`, or any remote URL.
2. Add a sandbox page in the extension manifest.
3. Keep `chrome.*` APIs out of the sandbox.
4. Pass only validated state messages into the sandbox:
   - `idle`
   - `queued`
   - `thinking`
   - `tooling`
   - `responding`
   - `awaiting-approval`
   - `compacting`
   - `failed`
   - `interrupted`
5. Reject messages containing executable code, URLs, event payload objects, context keys, prompt text, response text, tool input, or tool output.
6. Stop playback and tear down the iframe when the feature is disabled.

## Rollback

To disable vibes without removing code:

1. Force the feature flag off.
2. Clear the stored `enabled` preference.
3. Abort active streams owned only by the vibes module.
4. Close the audio context or fade to zero and disconnect nodes.
5. Leave existing live-state badge streaming untouched.
