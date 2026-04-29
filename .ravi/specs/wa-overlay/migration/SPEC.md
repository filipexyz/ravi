# wa-overlay → SDK consumer migration

Status: active
Owner: dev (task-478b2acf)
Last updated: 2026-04-28

## Goal

Eliminate `src/whatsapp-overlay/bridge.ts` (3.925 LOC, custom Bun HTTP server on `127.0.0.1:4210`) by **consuming the published `@ravi-os/sdk` directly from the Chrome extension**.

The bridge predates the SDK and the public gateway. With Phase 3 of `@ravi-os/sdk` closed and `0.1.0` published, every CLI in the registry is reachable via gateway HTTP and typed by the SDK. The bridge is now duplication: extra port, ad-hoc auth, divergent contracts.

## Single Surface Principle (load-bearing)

The Ravi command registry is the **single source of operational surface**. The SDK is the typed projection of that registry. Anything an operator can do via CLI, an SDK consumer (extension included) MUST be able to do via the same command path.

Consequences (MUST):

1. **No `overlay/*` command group.** The extension is a consumer of the existing surface, not a new namespace.
2. **No daemon-side aggregator endpoints** that exist only to pre-shape data for one UI. Composition happens in the consumer.
3. **No multiplex endpoints** that wrap N existing commands behind a single `--action` switch. The consumer calls the existing commands.
4. **No new commands at all in this migration.** Decided 2026-04-28: every overlay endpoint either maps to an existing command (CONSUMER), opt-in extends an existing command (EXTEND), moves to extension-local storage (LOCAL), or is dropped (DROP). The DOM automation channel (Canal B) is dropped because its only consumer is a debug-visual outline helper not worth a registry footprint.
5. **Existing commands MAY be extended** (new option, new field in payload, `--rich` flag, `@Returns.binary()` escape hatch) when the existing shape is insufficient. Extension is preferred over a new sibling command.

This is the inverse of the bridge's design. The bridge owns 22 hand-tuned routes; the SDK owns ~300 commands and we add the extension on top — with **zero new commands** in this migration.

## Endpoint inventory and resolution

The bridge registers 22 routes (`bridge.ts:469-555`). The following table is the authoritative migration plan. For each route, the resolution is one of:

- **CONSUMER** — extension composes parallel SDK calls; daemon does no aggregation. No new command.
- **EXTEND** — existing SDK command receives a new option/field/return shape; no new command path.
- **LOCAL** — moves to extension-local storage (`chrome.storage.local`); no daemon endpoint.
- **DROP** — server-internal route with no extension consumer, OR a debug-visual feature not worth migrating.

Legend
- `ext` — consumed by `extensions/whatsapp-overlay/background.js`
- `srv` — server-internal only

| # | Bridge route | Method | Side | Resolution | SDK target |
|---|---|---|---|---|---|
| 1 | `/api/whatsapp-overlay/snapshot` | GET | ext | CONSUMER | parallel: `sessions list`, `instances list`, `agents list`, `routes list`, plus extension state from `chrome.storage.local` |
| 2 | `/api/whatsapp-overlay/current` | GET | srv | DROP | not consumed |
| 3 | `/api/whatsapp-overlay/current` | POST | ext | LOCAL | extension keeps "currently rendered view" in `chrome.storage.local`; no daemon roundtrip |
| 4 | `/api/whatsapp-overlay/session/workspace` | GET | ext | EXTEND | `sessions read --session <s> --workspace` (or equivalent rich projection — confirm shape vs `buildOverlaySessionWorkspaceTimeline`) |
| 5 | `/api/whatsapp-overlay/session/prompt` | POST | ext | CONSUMER | `sessions send` puro. Optimistic "thinking" UI state lives in the extension (React local state); daemon already emits real activity events via NATS |
| 6 | `/api/whatsapp-overlay/session/action` | POST | ext | CONSUMER | extension calls `sessions abort` / `sessions reset` / `sessions set-thinking` / `sessions rename` directly; no multiplex |
| 7 | `/api/whatsapp-overlay/tasks` | GET | ext | CONSUMER | parallel: `tasks list`, plus per-task `tasks show` (or a single `tasks list --rich` extension that includes recent events) |
| 8 | `/api/whatsapp-overlay/tasks/dispatch` | POST | ext | EXTEND | `tasks dispatch` returns an enriched envelope (or extension re-fetches tasks list after dispatch). Overlay-specific actor/session metadata becomes optional on `tasks dispatch`. |
| 9 | `/api/whatsapp-overlay/insights` | GET | ext | EXTEND | `insights list --rich` (one option flag adds the lineage/group projections that `buildOverlayInsightsPayload` produced); no separate command |
| 10 | `/api/whatsapp-overlay/artifacts` | GET | ext | EXTEND | `artifacts list --rich` (analogous extension flag for the projections in `buildOverlayArtifactsPayload`) |
| 11 | `/api/whatsapp-overlay/artifact-blob` | GET/HEAD | ext | EXTEND | `artifacts blob --id <id>` returning binary via `@Returns.binary()` escape hatch on the **existing `artifacts` group** (see `Binary returns amendment`) |
| 12 | `/api/whatsapp-overlay/v3/placeholders` | GET | ext | LOCAL | placeholder snapshot is local UI cache; extension owns it (no daemon roundtrip needed once Canal B is dropped) |
| 13 | `/api/whatsapp-overlay/v3/command` | POST | ext | CONSUMER | only command observed is `chat.bindSession`, which multiplexes to `routes ...` / `instances connect` (`executeOmniRoute({bind-existing})`); extension calls those directly |
| 14 | `/api/whatsapp-overlay/chat-list/resolve` | POST | ext | CONSUMER | extension composes `instances list` + `routes list` + small chat-list-match logic shipped in extension JS |
| 15 | `/api/whatsapp-overlay/message-meta` | POST | ext | EXTEND | `sessions read --message-id <id>` projection (or new option on `sessions read`) |
| 16 | `/api/whatsapp-overlay/omni/panel` | GET | ext | CONSUMER | parallel: `instances show`, `routes list --instance <i>`, `agents list` |
| 17 | `/api/whatsapp-overlay/omni/route` | POST | ext | CONSUMER | extension calls `routes ...` / `instances connect` / `sessions ...` directly per action; no multiplex |
| 18 | `/api/whatsapp-overlay/bind` | POST | ext | LOCAL | overlay-local binding store moves into `chrome.storage.local`; no daemon endpoint. (If the binding must be shared across browser profiles or the daemon must read it, escalate as a separate spec — out of scope here.) |
| 19 | `/api/whatsapp-overlay/dom/command` | POST | srv | DROP | not consumed |
| 20 | `/api/whatsapp-overlay/dom/command/next` | GET | ext | DROP | DOM automation Canal B dropped; only product use was `placeholder.outline` debug-visual, not worth a registry footprint |
| 21 | `/api/whatsapp-overlay/dom/result` | POST | ext | DROP | DOM automation Canal B dropped |
| 22 | `/api/whatsapp-overlay/dom/result` | GET | srv | DROP | not consumed |

Outcome:

- **0 new commands.** Period.
- **0 multiplex commands.**
- **0 aggregator endpoints.**
- **3 LOCAL** routes (publish-view, v3/placeholders, bind) move to `chrome.storage.local` — extension owns its own UI/binding state.
- **6 EXTEND** routes nudge existing commands (sessions read for workspace + message-meta, tasks dispatch, insights list, artifacts list, artifacts blob via `@Returns.binary()`). Each extension is small, opt-in, and keeps the default shape stable.
- **1 schema amendment** in `sdk/schema/SPEC.md`: `@Returns.binary()` escape hatch (generic, not overlay-specific).
- **8 CONSUMER** routes resolved by parallel SDK calls in the extension (snapshot, session-prompt, session-action, tasks list, v3/command bind, chat-list/resolve, omni/panel, omni/route).
- **5 DROP**: 3 server-internal routes the extension never used + 2 dropped DOM automation routes (Canal B).

## DOM automation: dropped (Canal B)

The DOM automation channel (`dom/command`, `dom/command/next`, `dom/result`) was a generic mechanism for the daemon to enqueue DOM operations against the WhatsApp Web client, with the extension long-polling and reporting results.

**Decision (2026-04-28): drop entirely.**

The only product feature riding on it is `placeholder.outline` — a debug-visual that draws an outline around a DOM selector for a few hundred ms. Not worth a registry footprint. If a future requirement actually needs DOM automation (clicking a chat, scrolling, reading page state), it returns as its own spec with a concrete use case.

Consequences:

- `enqueueDomCommandRequest`, `pendingDomCommands`, `domCommandResults`, `handleDomCommand`, `handleNextDomCommand`, `handleDomResult`, `handleGetDomResult`, `runDomCommand` (in `cli.ts`), and the `placeholder.outline` event handler are all deleted.
- The `OverlayDomCommandRequest`/`OverlayDomCommandResult` types are deleted.
- No `pages` group, no `dom` group. Nothing.

## v3 placeholders: local cache (Canal A)

The v3 placeholders snapshot (`v3/placeholders` GET) is local UI state — what overlay placeholders are currently being tracked or displayed. Once Canal B is dropped, there's nothing to relay; the extension owns this cache directly.

The single `v3/command` case (`chat.bindSession`) multiplexes to `executeOmniRoute({action: "bind-existing"})`, which is itself a wrapper over existing route/instance operations. The extension calls those existing commands directly per the omni-route resolution above.

`overlayV3Relay` (process-bound singleton) is deleted with the bridge.

## Binary returns amendment

To eliminate `/artifact-blob` without a parallel HTTP path, the SDK schema spec gets one amendment: `@Returns.binary()`. Handlers marked binary return a `Response` whose body bytes pass through the gateway pipeline unchanged; the SDK client surfaces them as a `Blob`/`ReadableStream` instead of JSON.

This is a generic amendment to `.ravi/specs/sdk/schema/SPEC.md` (and reflected in `sdk/gateway/SPEC.md`); not overlay-specific. `artifacts blob` is the first consumer.

## Auth model

See `.ravi/specs/wa-overlay/auth/SPEC.md` (multi-server: extension stores a list of `{ name, baseUrl, contextKey }` and switches between them).

## Phasing

1. **A. Audit & spec** — this document and `auth/SPEC.md`. **Done**.
2. **B. SDK gaps (EXTEND only)** — implement opt-in extensions on existing commands:
   - `sessions read --workspace` projection (covers session/workspace)
   - `sessions read --message-id` projection (covers message-meta)
   - `tasks dispatch` accepts overlay-specific optional fields and returns enriched envelope
   - `insights list --rich`
   - `artifacts list --rich`
   - `artifacts blob` under existing `artifacts` group, using `@Returns.binary()` escape hatch
   - SDK schema amendment for `@Returns.binary()`
3. **C. Auth** — see `auth/SPEC.md`.
4. **D. Migrate extension** — replace `bridgeFetch` with SDK client; switch `BRIDGE_BASE` for gateway URL + context-key from active server entry. Rebuild composition (snapshot, tasks, session-action, omni-panel, omni-route, chat-list-resolve, v3/command bind, placeholder cache, v3/binding store) in extension JS using parallel SDK calls and `chrome.storage.local`.
5. **E. Delete bridge + DOM automation** — remove `src/whatsapp-overlay/bridge.ts` (3.925 LOC), purge `4210` / `BRIDGE_BASE` references, delete DOM command queue (Canal B) including `runDomCommand` in `cli.ts` and the `placeholder.outline` debug helper, delete `overlayV3Relay`, refresh skills/docs.
6. **F. Smoke test** — load extension in Chrome; exercise chat-list, task-workspace, kanban, insights, artifacts, omni-panel, bind flow; confirm `ravi.audit.completed` events show only existing command names (sessions/tasks/instances/etc.) — never `overlay.*` or `pages.*`, neither of which exist.

## What does NOT happen in this migration

- No `overlay <command>` CLI group.
- No `pages <command>` CLI group.
- No `dom <command>` CLI group.
- No new aggregator endpoints (snapshot, tasks-snapshot, omni-panel) on the daemon.
- No multiplexing wrappers (session-action, omni-route, v3/command).
- No daemon-side persistence of "current overlay view" or "extension bindings"; the extension owns its UI/binding state.
- No DOM automation surface (Canal B dropped).

If a future requirement wants any of the above (e.g. cross-machine binding sync, real DOM automation), it is a separate spec, with explicit justification, not piggybacked on this migration.

## Backwards compatibility

None required. The bridge is local-only (`127.0.0.1:4210`) and the only consumer is the development Chrome extension. Cut hard once parity is proven.

## Risks

- **Composition regressions** — moving snapshot/tasks/omni-panel composition to the extension means latency and ordering bugs become extension-side. Acceptable trade-off; the extension has React already and is the right place for UI shaping.
- **Optional fields creep** — EXTEND additions to existing commands MUST stay opt-in and non-breaking. Default response shape stays identical for non-overlay callers.
- **Lost debug visual** — `placeholder.outline` goes away with Canal B. If debugging selectors visually becomes important again, reintroduce as a content-script-only feature in the extension (no daemon involvement) or as a dedicated spec with a concrete use case.

## Validation criteria

1. `bridge.ts` removed (`-3925 LOC`).
2. No references to `BRIDGE_BASE` or port `4210` outside legacy comments.
3. No `overlay <command>`, `pages <command>`, or `dom <command>` group in `ravi --help`.
4. Zero new commands introduced by this migration.
5. Extension uses `@ravi-os/sdk` exclusively; no custom HTTP fetch helpers.
6. Extension UI parity in Chrome (chat-list, task-workspace, kanban, insights, artifacts, omni-panel, bind flow).
7. `bun run build && bun run typecheck && bun test` green.
8. `ravi.audit.completed` events emit only existing command names for overlay-driven actions.
