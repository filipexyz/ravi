# Why this migration is consumer-composition, not new-namespace

## Context

Dev's first audit (Fase A draft, 2026-04-28) proposed creating an `overlay` command group with **18 new commands** plus an `artifacts blob` extension, on the grounds that:

1. Several bridge endpoints "compose existing commands and cannot collapse to a single existing call".
2. Several endpoints multiplex actions (`session-action`, `omni-route`) and "decomposing would push composition to the browser".
3. Surfacing all of that under one `overlay` group would keep permissions simple.

That direction was rejected on 2026-04-28.

## Why the new-namespace approach was wrong

The bridge was built before the SDK existed. Its endpoints are **not requirements**; they are accidents of the bridge being a hand-tuned HTTP server pretending to be a UI backend. Migrating those routes 1:1 into a CLI/SDK group reproduces the accident at the registry layer and bakes overlay assumptions into the operational surface forever.

Specifically:

- **18 new commands** for a single UI consumer is a registry footprint that doubles every overlay-specific shape forever. New CLIs ship for one consumer; future consumers either reuse them awkwardly or grow another sibling group.
- **Aggregator endpoints** (snapshot, tasks-snapshot, omni-panel) bake the current overlay rendering into the daemon. Any future UI either matches those shapes or duplicates them.
- **Multiplex endpoints** (session-action with abort/reset/set-thinking/rename, omni-route with bind-existing/create-session/migrate-session) hide the underlying primitive operations behind a discriminated union. The CLI already has primitives for each; multiplexing them at the registry layer adds a second way to invoke each, with weaker types.
- **"Cannot collapse to existing"** was true in the bridge audit because the bridge endpoints were doing both data fetching AND data shaping. The SDK has no obligation to ship the shaping; the consumer does.

The single source of truth is the registry. Anything that is "the registry plus an extra UI-shaped wrapper" is debt.

## What the consumer-composition direction actually buys

1. **Registry stays clean.** ~300 commands, no "extension-shaped" subset. The next UI (web, mobile, voice) consumes the same SDK without inheriting overlay assumptions.
2. **Composition lives where it belongs.** The Chrome extension already has React, state machines, and workers. UI-specific aggregation is its job, not the daemon's.
3. **Auth scope simplifies.** Capabilities are `view sessions:*`, `view tasks:*`, `view artifacts:*`, etc. — the same scopes any operator-grade context-key already grants. No new `overlay:*` capability tree.
4. **Future surfaces inherit nothing extra.** If a Telegram desktop overlay or a CLI-based TUI wants the same "snapshot of the current chat", it composes the same SDK calls. No second `tg-overlay` group.
5. **Bridge deletion is total.** With no overlay-specific daemon-side aggregation, there is no "but we still need this one composer" tail. `bridge.ts` goes to zero.

## What we explicitly accept

- **More fetches per UI render.** The extension makes parallel SDK calls instead of one bridge call. This is fine on `127.0.0.1` and forces us to measure rather than guess.
- **Composition bugs become extension-side.** Latency, ordering, and stale-state bugs move from `bridge.ts` to extension JS. That's correct — the extension is the consumer.
- **EXTEND additions to existing commands.** Where an overlay payload genuinely needed richer projection (workspace timeline, message-meta, insights/artifacts grouping), the existing command grows an opt-in option flag, not a new sibling. Default response shape stays stable for non-overlay callers.

## DOM relay: dropped entirely (no exception)

Initial draft of this spec carved out a single legitimate exception: a minimal `pages` group (4 commands) for the DOM relay surface (`v3/placeholders`, `v3/command`, `dom/command/next`, `dom/result`).

Subsequent investigation (2026-04-28) showed the DOM relay has two distinct channels:

- **Canal A (`v3/command`, `v3/placeholders`)** — UI-level dispatcher. The only command observed is `chat.bindSession`, which multiplexes to `executeOmniRoute({action: "bind-existing"})`, itself a wrapper over existing route/instance commands. This is CONSUMER-shaped: the extension calls the existing primitives directly. Placeholders are local UI cache; extension owns them.
- **Canal B (`dom/command/next`, `dom/result`)** — actual DOM automation queue. The only product feature riding on it is `placeholder.outline` — a debug-visual that draws a coloured outline around a DOM selector for a few hundred ms. No real automation use cases.

Decision (Luís, 2026-04-28): **drop Canal B**. The debug-visual outline is not worth a registry footprint. Canal A reduces to CONSUMER. There is no DOM automation surface, no `pages` group, no `dom` group.

The migration ends with **zero new commands**. The extension consumes the existing SDK exclusively. If real DOM automation becomes a requirement later, it returns as its own spec with a concrete use case (clicking chats, scrolling, reading page state) — not piggybacked on this migration.

## Anti-patterns to block

- "Just one more `overlay` command for X" — if X exists in the SDK, compose it; if X needs a richer shape, EXTEND existing.
- "It's faster with one call" — measure first. On loopback, parallel calls are usually fine. Only optimise after a real benchmark.
- "We need DOM automation for Y" — write a separate spec with the concrete use case before reintroducing any DOM channel.
- "What about debug visuals?" — content-script-only feature in the extension. No daemon involvement.

## Direct quotes that produced this direction

From Luís, 2026-04-28:

- "ja temos todos os comandos no sdk"
- "só adaptar o overlay pra usar o do sdk"
- "escreve specs"
- "drop canal b"

The first two are the load-bearing constraint. The third is why this document exists. The fourth eliminated the last remaining exception, leaving the migration at exactly zero new commands.
