---
id: wa-overlay/vibes/strudel
title: WhatsApp Overlay Vibes Strudel Engine
kind: feature
domain: wa-overlay
capability: vibes
feature: strudel
tags:
  - extension
  - strudel
  - agpl
  - sandbox
  - webaudio
applies_to:
  - extensions/whatsapp-overlay
owners:
  - ravi-dev
status: draft
normative: true
---

# WhatsApp Overlay Vibes Strudel Engine

## Intent

The Strudel engine is an experimental vibes backend for richer browser-side sonification in the WhatsApp overlay.

For the Agent Vibes import build requested on 2026-06-05, this gate is explicitly accepted for local extension testing and the overlay MAY prefer Strudel with native WebAudio fallback.

## License Gate

Strudel packages used for this feature are `AGPL-3.0-or-later`.

The Ravi package is currently MIT. Therefore, bundling Strudel changes the licensing obligations of the extension build that includes it.

Decision recorded for this workstream:

- bundle `@strudel/web@1.3.0` locally under `extensions/whatsapp-overlay/vendor/strudel`;
- keep the upstream `LICENSE` file packaged with the extension;
- treat this as an explicitly gated Agent Vibes import build, not an implicit MIT-only dependency;
- keep `native` WebAudio as fallback when the sandbox or Strudel runtime fails.

Local development spikes MAY use Strudel when:

- the dependency is clearly marked experimental;
- the extension build variant is not treated as the normal MIT distributable;
- the repo records which Strudel packages and versions were bundled;
- the UI or docs expose the required license/source notices for that build variant.

If this gate is not satisfied, implementation MUST fall back to `wa-overlay/vibes` native WebAudio.

## Chrome MV3 Gate

Strudel MUST NOT run in a normal extension page, content script, background service worker, options page, or popup if it requires dynamic evaluation.

Strudel may run only in a Chrome extension sandbox page because:

- normal extension pages cannot relax CSP to include `unsafe-eval`;
- Strudel evaluation uses dynamic code execution;
- sandbox pages do not have direct access to extension APIs.

The sandbox page MUST:

- be listed in `manifest.json` under `sandbox.pages`;
- be packaged locally with the extension;
- have no `chrome.*` API access;
- accept messages only after a per-iframe token handshake from the overlay controller;
- validate every `postMessage` payload against a narrow allowlist;
- never receive raw Ravi event payloads.

Normal extension pages MUST keep the normal MV3 CSP and MUST NOT add `unsafe-eval`.

## Remote Code Gate

The Strudel engine MUST NOT load executable code from remote URLs.

Blocked examples:

- `<script src="https://unpkg.com/@strudel/web">`;
- `<script src="https://cdn.jsdelivr.net/...">`;
- dynamic `import("https://...")`;
- fetching JS/WASM and executing it;
- loading Strudel from `https://strudel.cc`.

All executable Strudel code MUST be bundled into the extension package or the feature is not allowed.

Samples are data, not code, but remote sample packs SHOULD be disabled by default. If remote samples are enabled for a spike, the UI MUST disclose that audio files are loaded from external URLs and the implementation MUST avoid passing private Ravi data into sample URLs.

## Message Contract

The content script or overlay controller MAY send only this shape into the sandbox:

```ts
type StrudelVibesMessage =
  | { type: "vibes.init"; token: string }
  | {
      type: "vibes.start" | "vibes.state" | "vibes.accent";
      token: string;
      state: VibeState;
      scene: VibeScene;
      volume: number;
      muted: boolean;
      key?: VibeKey;
      scaleMode?: VibeScaleMode;
      seed?: VibeSeed;
      visual?: VibeVisual;
      voices?: VibeVoice[];
    }
  | { type: "vibes.volume"; token: string; volume: number; muted: boolean }
  | { type: "vibes.stop"; token: string };

type VibeState =
  | "idle"
  | "queued"
  | "thinking"
  | "tooling"
  | "responding"
  | "awaiting-approval"
  | "compacting"
  | "failed"
  | "interrupted";

type VibeAccent =
  | "inbound"
  | "reaction"
  | "typing"
  | "unread"
  | "control"
  | "skill-loaded"
  | "released"
  | "delivered"
  | "delivery-failed";

type VibeScene = "cinematic" | "techno" | "lofi" | "chiptune" | "piano" | "jazz";

type VibeSeed = `v${string}`; // bounded hash bucket only, never a raw chat/session/path value
type VibeKey = "c" | "d" | "e" | "f" | "g" | "a";
type VibeScaleMode = "minor" | "dorian" | "aeolian" | "phrygian" | "locrian" | "major" | "mixolydian" | "lydian";

type VibeVisual = {
  intensity?: number;
  tension?: number;
  cps?: number;
  phase?: "idle" | "prompting" | "thinking" | "working" | "drop" | "resolve" | "queued" | "approval" | "alert";
};

type VibeVoice = {
  role?: "primary" | "secondary";
  state?: VibeState;
  seed?: VibeSeed;
  key?: VibeKey;
  scaleMode?: VibeScaleMode;
  intensity?: number;
  tension?: number;
  gain?: number;
  pan?: number;
  phase?: VibeVisual["phase"];
};
```

The sandbox MUST reject:

- strings intended as executable Strudel code from the backend;
- full event payload objects;
- prompt text;
- response text;
- tool input;
- tool output;
- raw provider events;
- file paths;
- URLs derived from Ravi events;
- context keys or credentials.

The sandbox MAY contain fixed Strudel patterns authored in source code. Runtime messages may select state/accent and intensity, but MUST NOT construct code from event data.

Secondary `voices`, when sent to the sandbox, MUST be treated as bounded visual/session metrics only for the Agent Vibes parity build. They MUST NOT include labels, session names, chat titles, tool names, provider raw data, prompts, responses, paths, URLs, or arbitrary Strudel fragments. They MUST NOT be appended as continuous musical layers to the Strudel `stack(...)`, because the published Agent Vibes demo keeps parallel voice count visual while the selected scene/conductor remains the musical source.

## Agent Vibes Parity

For the Agent Vibes import build, the Strudel sandbox SHOULD preserve the published Agent Vibes demo defaults and fixed scene patterns unless a change is explicitly required by the WhatsApp overlay safety boundary.

The overlay SHOULD default the Strudel Agent Vibes build to the same initial scene as the published web demo. Local session/chat/profile variation MAY alter bounded musical key, scale mode, tempo, intensity, and tension, but SHOULD NOT replace the fixed scene's instrumentation or add master pattern processing that materially changes the scene's timbre.

The sandbox SHOULD initialize Strudel audio using the packaged runtime's `initStrudel` path with an explicit browser `AudioContext` when available, and SHOULD call `initAudio` when the bundled runtime exposes it. This mirrors the published demo's startup path more closely than relying on implicit audio initialization.

## Engine Behavior

The Strudel engine MUST expose the same external behavior as the native vibes engine:

- one opt-in start gesture;
- mute/unmute;
- bounded volume;
- fade to idle on terminal events;
- stop on active server/session changes;
- silence on stream failure;
- no event payload persistence.

The Strudel engine SHOULD preserve a minimal pattern palette:

- `idle`: silence;
- `queued`: sparse low motif;
- `thinking`: quiet texture;
- `tooling`: distinct but restrained percussive layer;
- `responding`: short, lighter motion;
- `awaiting-approval`: attention cue with cooldown;
- `compacting`: slow filtered texture;
- `failed`: short dissonant cue, then silence;
- `interrupted`: quick stop cue, then silence.

The Strudel sandbox SHOULD throttle pattern re-evaluation to avoid clicky rapid re-renders while the conductor eases continuous parameters. The Agent Vibes baseline uses a minimum interval around 700ms between non-forced `evaluate(code)` calls.

The Strudel sandbox SHOULD derive or accept only bounded musical `key` and `scaleMode` values. It MUST NOT use raw session, chat, model, path, prompt, or event text as Strudel code or musical identifiers.

## Acceptance Criteria

- Strudel is present only under the explicit Agent Vibes import license decision above.
- Strudel executable code is packaged locally, not loaded from CDN or `strudel.cc`.
- Dynamic evaluation is confined to a sandbox page.
- The sandbox has no `chrome.*` access.
- The extension sends only validated state/accent messages to the sandbox.
- No raw Ravi payload, text, tool data, provider data, file path, URL, credential, or context key crosses into the sandbox.
- Disabling the feature tears down playback and removes the sandbox iframe.
