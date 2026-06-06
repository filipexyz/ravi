---
id: wa-overlay/vibes
title: WhatsApp Overlay Vibes
kind: capability
domain: wa-overlay
capability: vibes
tags:
  - extension
  - whatsapp
  - audio
  - events
  - webaudio
applies_to:
  - extensions/whatsapp-overlay
  - extensions/whatsapp-overlay/lib/live-state.js
  - extensions/whatsapp-overlay/lib/live-state-model.js
  - src/sdk/gateway/streaming
owners:
  - ravi-dev
status: draft
normative: true
---

# WhatsApp Overlay Vibes

## Intent

Vibes is optional local sonification for the WhatsApp overlay. It turns selected Ravi activity events into subtle audio cues while the operator works inside WhatsApp Web.

The feature is a browser-side affordance only. Ravi events, sessions, chats, routes, providers, tasks, and delivery remain owned by the backend and exposed through the SDK/gateway contract.

## Boundary

The overlay owns:

- the audio enable/mute UI;
- local WebAudio playback state;
- event-to-sound mapping for the current overlay context;
- non-sensitive UI preferences stored in `chrome.storage.local`;
- optional sandbox-hosted audio engines when explicitly gated by this spec.

The overlay MUST NOT own:

- NATS connectivity;
- Cursor hooks, local editor hooks, transcript tailers, SQLite watchers, or localhost hook servers;
- Ravi event persistence or replay source of truth;
- provider credentials, context keys outside the existing auth state, raw provider events, or raw message transcripts;
- session routing, agent assignment, task state, or chat identity.

## Activation

Vibes MUST be opt-in.

The overlay MUST NOT create, resume, or unlock an `AudioContext` before an explicit operator gesture such as pressing the vibes toggle.

The overlay MUST expose a compact mute/enable control in the existing Ravi overlay surface. The control SHOULD be icon-sized and MUST NOT compete with core session controls.

The overlay MAY remember these preferences:

- `enabled`: whether the operator opted in;
- `muted`: whether audio is currently muted;
- `volume`: bounded scalar, default at or below 0.25;
- `engine`: `strudel` for the explicitly gated Agent Vibes import build, with `native` as the fallback engine;
- `scene`: bounded scene id such as `cinematic`, `techno`, `lofi`, `chiptune`, `piano`, or `jazz`;
- `sceneDefaultVersion`: non-sensitive migration marker for one-time local default-scene changes;
- `accentChatEvents`: whether current-chat inbound/reaction accents are enabled.

The overlay MUST NOT store:

- event payload history;
- prompt text, response text, transcript text, tool input, tool output, or provider raw events;
- raw chat titles, raw file paths, raw workspace paths, or raw artifact paths for vibes parameterization;
- Strudel code supplied by remote sources or by backend events;
- provider API keys or short-lived voice connection secrets.

## Event Transport

The overlay MUST consume Ravi activity through the gateway streaming surface, not direct NATS.

Allowed stream inputs:

- `stream.events({ subject: "ravi.session.>", noClaude: true, noHeartbeat: true })` for broad session live-state updates when the overlay already has permission to view system events;
- `stream.session(sessionName, { timeout: 0 })` for a selected session;
- `stream.chat(chatId)` for the current WhatsApp chat accents when the overlay has chat view permission.

The overlay MUST use the active gateway/context-key entry from `wa-overlay/auth`.

The overlay MUST treat stream authorization failures as "vibes unavailable" and MUST NOT try to bypass them with direct local ports, direct NATS, or unauthenticated localhost listeners.

The overlay SHOULD reuse the existing live-state normalization in `extensions/whatsapp-overlay/lib/live-state-model.js` before driving continuous audio layers. Vibes should be a consumer of the same normalized state that drives badges.

The overlay MAY use local active-composer input as an additional conductor signal after vibes has already been enabled by the operator. That signal MUST be limited to sanitized metrics such as draft length, length delta, and timing; it MUST NOT persist, render, or send the draft text itself to storage, the backend, or the audio sandbox.

## Event Mapping

The mapping has two layers:

- **state layer**: continuous, low-volume bed that reflects the selected session's current activity;
- **accent layer**: short cues for high-signal event edges.
- **voice lane layer**: compact secondary voices for other active sessions visible in the overlay.

The overlay MUST route normalized Ravi events through a local conductor/state-machine before rendering audio. The conductor MUST maintain continuous musical parameters (`intensity`, `tension`, and `cps`) and ease them toward event-driven targets over time, so the music breathes between events instead of jumping from one static snapshot value to another.

The conductor MUST receive sanitized event shapes only. It MUST NOT persist or forward prompt text, response text, tool input, tool output, raw chat titles, raw paths, or raw provider events to the audio sandbox.

Local composer `draft` and `typing` events MAY drive the conductor's `prompting` phase, but they MUST use bounded numeric metrics only and MUST be rate-limited.

When multiple sessions are active in parallel, the selected session SHOULD remain the primary/full musical voice. Other active sessions MAY be represented as secondary voice lanes with bounded gain, pan, state, key/scale, and intensity/tension metrics for compact UI/status display. The overlay SHOULD consider visible active sessions from both active/hot lists and recent/recent-chat lists, because the composition layer may keep a busy session in a recent bucket to avoid duplicate display. The overlay SHOULD cap displayed voice lanes to four total lanes and treat overflow sessions as visual-only until they become higher priority.

When using the Agent Vibes Strudel import build, secondary session lanes MUST NOT be added as continuous Strudel musical layers. The published Agent Vibes demo uses voice/session count as visual state, not as extra `stack(...)` layers. Secondary sessions MAY trigger bounded short accents in a future design, but the continuous musical bed MUST remain driven by the selected primary session/conductor so the scene timbre stays close to the demo.

Voice lanes MUST NOT send raw session names, raw chat titles, prompts, responses, tool input/output, file paths, or provider raw events into sandbox engines. UI labels MAY show already-visible session names in the overlay, but sandbox payloads MUST use only bounded musical fields.

### Session State Layer

The state layer MUST be derived from session-scoped gateway events only.

| Source event | Condition | Vibe state | Notes |
| --- | --- | --- | --- |
| `ravi.session.{name}.runtime` | `data.type === "prompt.received"` | `thinking` | Start or refresh a soft musical bed. MUST NOT sonify prompt text. |
| `ravi.session.{name}.runtime` | `data.type === "dispatch.queued"` | `queued` | Shorter, lower cue than active thinking. |
| `ravi.session.{name}.runtime` | `data.type === "turn.interrupt.requested"` | `interrupted` | Short stop/duck cue. |
| `ravi.session.{name}.runtime` | `data.type === "runtime.control"` | `control` | Short neutral cue for accepted steering/control. |
| `ravi.session.{name}.runtime` | `data.type === "status" && data.status === "queued"` | `queued` | Mirrors provider status. |
| `ravi.session.{name}.runtime` | `data.type === "status" && data.status === "thinking"` | `thinking` | Mirrors provider status. |
| `ravi.session.{name}.runtime` | `data.type === "status" && data.status === "compacting"` | `compacting` | Distinct slow texture. |
| `ravi.session.{name}.runtime` | `data.type === "status" && data.status === "idle"` | `idle` | Fade out. |
| `ravi.session.{name}.runtime` | `data.type === "turn.complete"` | `idle` | Terminal success cue, then fade out. |
| `ravi.session.{name}.runtime` | `data.type === "turn.failed"` | `failed` | Error cue, then idle or blocked depending live state. |
| `ravi.session.{name}.runtime` | `data.type === "turn.interrupted"` | `interrupted` | Short cue, then idle. |
| `ravi.session.{name}.runtime` | `data.type === "silent"` | `idle` | No assistant output; quiet terminal cue only if enabled. |
| `ravi.session.{name}.runtime` | `data.type === "provider.inactive" \|\| data.type === "tool.stuck"` | `failed` | Safety/error cue. |
| `ravi.session.{name}.runtime` | `data.type === "skill.visibility.loaded"` | `skill-loaded` | Optional soft accent only. |
| `ravi.session.{name}.runtime` | `data.type === "task.runtime.release"` | `released` | Optional soft accent only. |
| `ravi.session.{name}.tool` | `data.event === "start"` | `tooling` | Tool bed or accent. MUST NOT expose tool input. |
| `ravi.session.{name}.tool` | `data.event === "end" && !data.isError` | `thinking` | Completion accent, return to previous active state. |
| `ravi.session.{name}.tool` | `data.event === "end" && data.isError` | `failed` | Error cue. MUST NOT expose output. |
| `ravi.session.{name}.stream` | `data.chunk` present | `responding` | Optional tick/gate; MUST debounce to avoid per-token noise. |
| `ravi.session.{name}.response` | `data.response` present | `responding` | Terminal assistant response cue. MUST NOT sonify text content. |
| `ravi.session.{name}.delivery` | `data.status === "delivered"` | `delivered` | Optional very short cue. |
| `ravi.session.{name}.delivery` | `data.status === "failed" \|\| data.status === "dropped"` | `delivery-failed` | Error cue. |
| `ravi.approval.request` | matching `data.sessionName` | `awaiting-approval` | Attention cue until response or timeout. |
| `ravi.approval.response` | matching `data.sessionName` | previous state or `thinking` | Resolution cue. |

The overlay MUST ignore `ravi.session.{name}.claude` for vibes by default. Legacy Claude events MAY be used only as fallback if normalized `runtime`/`tool`/`response` events are absent.

The overlay MUST ignore `provider.raw` for sound selection. Provider raw events MAY exist in event history, but vibes must use normalized Ravi event types.

### Chat Accent Layer

Chat accents are optional and MUST be scoped to the currently selected WhatsApp chat.

Allowed chat stream inputs:

- `message.received.>` projected by `stream.chat(chatId)`;
- `reaction.received.>` projected by `stream.chat(chatId)`;
- `presence.typing` projected by `stream.chat(chatId)`;
- `chat.unread-updated` projected by `stream.chat(chatId)`.

| Chat event | Condition | Accent | Notes |
| --- | --- | --- | --- |
| `message` | current chat, inbound human message | `inbound` | Short cue. MUST NOT encode sender or text. |
| `reaction` | current chat reaction | `reaction` | Optional short cue. |
| `presence` | `isTyping === true` | `typing` | Optional very low cue with cooldown. |
| `unread` | unread count increases | `unread` | Optional short cue. |

The overlay MUST NOT subscribe to all chats for audio accents. Broad chat monitoring is out of scope for vibes.

## Context Parameters

Vibes MAY vary musical parameters by safe context selectors so different chats, sessions, agents, providers, workspaces, or file categories can sound distinct.

Allowed parameters:

- oscillator base frequency;
- timbre/color;
- accent density and cooldown;
- stereo pan;
- state transition duration;
- active scene id;
- fixed native-engine pattern variant.

Allowed selectors:

- current chat id or chat title as a transient hash/bucket only;
- selected session name/key as a transient hash/bucket only;
- agent id, provider, model, and task/artifact kind when already present in the overlay snapshot;
- sanitized relative path category from normalized metadata, such as first relative folder bucket and file extension.

The overlay MUST NOT persist raw selectors used for vibes context. Preferences may persist only user settings such as `enabled`, `muted`, `volume`, `engine`, `scene`, and feature toggles.

The overlay MUST NOT watch the filesystem, install local editor hooks, or infer file changes from the browser DOM. File/folder parameterization is allowed only when a Ravi event or snapshot already carries normalized metadata that the overlay is authorized to see.

When deriving file/folder parameters:

- absolute paths MUST be ignored;
- path values containing `..`, URL schemes, Windows drive prefixes, credentials, or query strings MUST be ignored;
- the native engine MAY use only a bounded path bucket and file extension;
- raw path strings MUST NOT be written to storage, rendered in vibes UI, or sent to a sandbox engine.

## Blocked Events

The overlay MUST NOT map these by default:

- `ravi.audit.>` because audit events may expose sensitive denial metadata;
- `ravi.contacts.>` because contact activity is not part of the current chat/session sonification contract;
- `ravi.outbound.>` because outbound intent may include message text or delivery details outside the selected session;
- `ravi.media.send` and `ravi.stickers.send` because file paths and media intent are sensitive;
- `ravi._cli.cli.>` because command execution details can leak tooling and output;
- raw `message.received.>` outside `stream.chat(chatId)`;
- any event payload field containing prompt text, response text, tool input, tool output, raw provider event, absolute local file path, credential, or context key.

## Audio Engine

The production default SHOULD be `native` unless the Strudel AGPL gate in `wa-overlay/vibes/strudel` records an explicit license/package decision for that build.

The WhatsApp overlay Agent Vibes import build MAY default to `strudel` after that gate is accepted, but MUST keep `native` as a no-network, no-eval fallback.

The native engine SHOULD be enough for MVP:

- one shared `AudioContext`;
- bounded gain node;
- a small oscillator/noise/sample-free palette;
- ADSR envelopes for accents;
- conductor-driven crossfades for `idle`, `prompting`, `thinking`, `working`, `drop`, and `resolve`, with Ravi states such as `queued`, `tooling`, `awaiting-approval`, `failed`, and `interrupted` mapped into those musical phases plus tension/intensity changes;
- a single continuous local music behavior that adapts scene, intensity, tension, and tempo to current state;
- short accents layered into the continuous bed for high-signal event edges;
- no dynamic code execution.

The native engine MUST ignore legacy `mode` and `modeExplicit` preferences, including values written by temporary pulse-first prototypes.

Continuous music MUST be musical rather than a stationary drone: it SHOULD use bounded rhythmic notes, scene-specific scales/timbres, and a very low pad only as support. The bed MUST remain quiet by default and bounded by the configured volume.

The overlay SHOULD expose a compact visual player inspired by Agent Vibes: scene chips, play/stop, volume, phase, and intensity/tension/tempo meters. These controls MUST remain local UI state and MUST NOT render prompt, response, tool input/output, raw chat title, or raw file path text.

Strudel MAY be tested only under `wa-overlay/vibes/strudel`.

## Safety

Vibes MUST be quiet by default.

The overlay MUST rate-limit accents. A burst of stream chunks or typing events MUST NOT produce an unbounded number of notes.

The overlay MUST stop or fade all audio when:

- the operator disables vibes;
- the active server changes;
- the active context key is removed;
- the current chat/session binding changes and no selected session remains;
- the browser tab is hidden for longer than a configurable grace period;
- the stream disconnects and does not reconnect within the retry window.

Errors MUST degrade to silence. Vibes MUST NOT interrupt core overlay UI behavior.

## Acceptance Criteria

- Vibes can be enabled with one compact operator gesture and muted with one compact control.
- Audio starts only after user gesture and stops when disabled or when stream authorization fails.
- The extension uses gateway streams, not direct NATS or local hook servers.
- Session state is driven by normalized Ravi events and existing live-state semantics.
- Prompt text, response text, tool input/output, provider raw events, file paths, credentials, and context keys are never written into vibes storage or audio messages.
- The native engine can sonify selected-session `thinking`, `tooling`, `responding`, `failed`, and `idle` transitions without external network code.
- Strudel code is not bundled or enabled unless the Strudel sandbox/license gate in `wa-overlay/vibes/strudel` is satisfied.
