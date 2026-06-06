# WhatsApp Overlay Vibes Checks

## Spec Index

```bash
bin/ravi specs sync --json
bin/ravi specs get wa-overlay/vibes --mode full --json
bin/ravi specs get wa-overlay/vibes/strudel --mode rules --json
```

## Unit Tests

When implementation lands, add focused tests for:

- event-to-vibe reducer maps `prompt.received` to `thinking`;
- `tool start/end` transitions do not store input or output;
- `turn.complete`, `turn.interrupted`, `silent`, and `status: idle` fade to idle;
- `turn.failed`, `provider.inactive`, and `tool.stuck` map to failure;
- `stream` events are debounced;
- broad blocked topics are ignored;
- stream reconnect does not duplicate active audio layers;
- active server/session changes abort old streams;
- preferences store only `enabled`, `muted`, `volume`, `engine`, `scene`, and optional chat accent settings;
- legacy `mode` and `modeExplicit` preferences are ignored and removed from normalized storage;
- the native default produces quiet continuous music;
- short accents layer into the continuous bed without replacing it;
- normalized Ravi events drive a local conductor that eases `intensity`, `tension`, and `cps` instead of directly mapping snapshots to static visual/audio values;
- Strudel messages include only bounded musical `key` and `scaleMode` values, not raw context selectors;
- Strudel `evaluate(code)` is throttled during conductor ticks to avoid clicky rapid re-renders;
- continuous music sounds like rhythmic music rather than a stationary oscillator drone;
- stop control cancels future score steps and ramps the continuous gain to zero;
- compact visual controls render scene chips, play/stop, volume, phase, and intensity/tension/tempo meters;
- context profiles vary by chat/session bucket without persisting raw chat titles;
- relative path metadata maps to bounded buckets and extensions only;
- absolute paths, `..`, URLs, and credentials are ignored for path-derived parameters.

Likely commands:

```bash
bun test src/whatsapp-overlay/extension-live-state.test.js
bun test src/whatsapp-overlay/extension-vibes.test.js
bun test src/sdk/gateway/streaming/channels.test.ts
```

## Browser Checks

Manual checks in Chrome:

- load unpacked extension without CSP install errors;
- enable vibes with one explicit click;
- verify no audio before that click;
- mute/unmute works without changing session state;
- switching the active server stops old audio;
- selected-session prompt produces a quiet thinking cue;
- tool event produces a distinct cue;
- response/turn completion fades to idle;
- stream disconnect degrades to silence;
- no prompt/response/tool text appears in `chrome.storage.local`;
- no raw chat title or raw file path appears in `chrome.storage.local`.

## Strudel Gate Checks

If Strudel is enabled:

- package scan shows no remote script execution URLs in built extension JS;
- sandbox page exists and is listed under `manifest.json` `sandbox.pages`;
- normal extension pages do not add `unsafe-eval`;
- sandbox has no `chrome.*` access;
- sandbox accepts only the allowlisted state schema;
- sandbox rejects code strings and URLs from backend events;
- license review has approved AGPL compatibility for the intended distribution mode.

## Build

Before declaring implementation done:

```bash
bun run build
```

Build success is not enough. Review the built extension bundle for:

- `https://unpkg.com`
- `https://cdn.jsdelivr.net`
- `https://strudel.cc`
- unexpected `new Function` or `eval` outside the sandbox bundle
- event payload text persisted in storage code
