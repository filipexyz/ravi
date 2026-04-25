# Claude Code Provider Rationale

## Why This Provider Matters

This is the current richest runtime path. It proves the host can support session resume, fork, native hooks, plugins, spec mode, remote execution, partial text, and live model switching.

It also reveals which abstractions are not yet generic because some capabilities exist only through provider-native features.

## Why It Should Stay Behind The Same Contract

Even when a provider has rich native hooks, Ravi still needs one permission policy, one trace model, one response pipeline, and one session state model. Native power is useful only when it is normalized into Ravi concepts.

## Important Contrast With Codex

- This provider uses native hook integration for tools and approvals.
- Codex uses app-server requests plus Ravi dynamic tools.
- This provider supports spec server and plugins.
- Codex currently does not.
- Codex has native runtime controls.
- This provider currently does not expose a generic `control()` handle.

The new runtime abstraction must represent these as capabilities, not as assumptions tied to provider IDs.
