# Why Vibes Exists

The WhatsApp overlay already shows compact Ravi state through badges and the drawer. Audio can make long-running agent activity easier to track without forcing the operator to keep scanning the UI.

The goal is not "music mode" for its own sake. The useful product signal is ambient awareness:

- a turn started;
- the agent is thinking;
- a tool is running;
- the agent is responding;
- approval is pending;
- something failed;
- the turn is done.

## Why Not Import Agent Vibes Directly

The Agent Vibes Cursor extension is a useful reference, but its integration model is wrong for the WhatsApp overlay.

Ravi MUST NOT port:

- Cursor hook installation;
- transcript tailing;
- SQLite chat draft polling;
- unauthenticated localhost hook servers;
- editor typing watchers.

Those signals are IDE-specific, invasive, and not part of Ravi's gateway contract. The WhatsApp overlay already has a better substrate: Ravi events normalized through the SDK/gateway stream.

## Why Native WebAudio First

The production path should stay license-compatible with Ravi's MIT package and Chrome MV3 constraints. A tiny native WebAudio engine is enough for the first useful version and avoids:

- AGPL compatibility risk;
- dynamic code execution;
- remote hosted code review failures;
- large dependency surface;
- sandbox messaging complexity.

## Why Keep Strudel As A Gated Spike

Strudel is musically expressive and designed for browser audio. It is worth testing because it can make the mapping richer quickly.

It is not safe as the default production engine today because:

- Strudel packages are `AGPL-3.0-or-later`;
- Ravi is currently MIT;
- `@strudel/web` uses dynamic evaluation through `Function`;
- Chrome MV3 forbids `unsafe-eval` in normal extension pages;
- Chrome Web Store policy does not allow remotely hosted code such as CDN-loaded JS/WASM.

A sandbox page can isolate dynamic evaluation from extension APIs. That makes a local experiment feasible, but it does not remove the license decision.

## Why Event Mapping Is Session-Scoped

The overlay is an operator surface for the active WhatsApp context. Broad global sonification would turn the extension into an always-on monitoring device and create privacy risk.

The default mapping stays scoped to:

- the selected Ravi session;
- the selected WhatsApp chat;
- events already authorized by the active gateway context key.

This preserves the existing `wa-overlay/auth` model and avoids hidden background surveillance.

## Why Context Parameters Are Buckets

Different chats or workspaces should be able to sound subtly different. That helps the operator understand where activity is happening without reading the panel.

The useful signal is a bounded musical profile, not the raw identity data. For that reason, the extension should derive local buckets from chat/session/agent/path metadata and discard the source value. A chat title, folder name, or file path should influence frequency/timbre/pan, but it should not be persisted as a vibes profile or sent to a sandbox.

File and folder signals are especially sensitive. They are allowed only when Ravi already emits normalized metadata for an authorized event. The WhatsApp overlay must not become a filesystem watcher.

## Rejected Alternatives

- **Direct NATS from extension**: rejected because browser extension should go through gateway auth and permissions.
- **A new backend "vibes" event bus**: rejected for MVP because existing normalized runtime/session streams already contain the needed states.
- **Sonify raw text or provider events**: rejected because it leaks sensitive prompt/tool/provider data and creates provider-specific coupling.
- **Ship Strudel from CDN**: rejected because Chrome MV3 remote hosted code policy requires extension code to be packaged locally.
- **Enable audio automatically on page load**: rejected because browser autoplay policy and operator expectation require explicit user gesture.
- **Per-folder sound via local filesystem watcher**: rejected because the browser extension should use Ravi-authorized event metadata, not local hooks.
