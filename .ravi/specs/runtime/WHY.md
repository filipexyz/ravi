# Runtime Rationale

## Why This Exists

Ravi is moving toward more than two execution engines. Without a hard runtime spec, every new provider will pressure the codebase to add branches in dispatcher, launcher, prompt building, tools, traces, model selection, and channel output.

The correct design is a stable host runtime with provider adapters behind a narrow contract.

## Design Position

- Ravi owns product semantics: session, chat, route, task, source, contact, actor, permission, trace, response, and artifacts.
- Providers own only native execution transport and event normalization.
- Capabilities are the extension point. Provider IDs are not the extension point.
- Runtime traces are the debugging source of truth after provider handoff.
- Terminal turn events are not optional. They are the boundary that lets Ravi release queued prompts safely.

## Tradeoffs

- A strict provider contract makes adapter implementation harder, but prevents runtime behavior from spreading through unrelated modules.
- Provider-native features should be exposed only when they can be mapped into Ravi concepts. Otherwise they should stay inside provider-local code.
- A generic runtime abstraction should not hide meaningful differences. It should make differences explicit as capabilities and tested event mappings.

## Why Before Pi

Pi should be added against the abstraction, not used to define the abstraction implicitly. This spec captures the current host/runtime responsibilities and the gaps that need to be closed before Pi becomes another production provider.
