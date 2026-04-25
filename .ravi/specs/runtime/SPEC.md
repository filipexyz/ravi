---
id: runtime
title: "Runtime"
kind: domain
domain: runtime
capabilities:
  - dispatch
  - provider-contract
  - host-services
  - event-loop
  - session-continuity
  - traces
tags:
  - runtime
  - providers
  - sessions
  - tools
applies_to:
  - src/runtime
  - src/session-trace
  - src/bot.ts
  - docs/runtime-provider-contract.md
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime

## Intent

Ravi Runtime turns session prompts into provider execution while keeping Ravi as the owner of sessions, routing, task context, permissions, traces, responses, and durable provider state.

The runtime abstraction exists so new execution engines can be added without copying session, queue, tool, permission, delivery, or observability logic.

## Current Abstractions

- `RuntimeSessionDispatcher`: queueing, debounce, active-session reuse, interruption, restart decisions, concurrency, task delivery barriers.
- `RuntimeSessionLauncher`: session/agent/provider resolution, user-message persistence, task runtime resolution, request build, provider start, event-loop handoff.
- `RuntimeStartRequest`: provider-facing start contract.
- `RuntimeSessionHandle`: live provider handle, event stream, interrupt, optional model switch, optional native control.
- `RuntimeProvider`: adapter registration, capabilities, optional bootstrap, start session.
- `RuntimeCapabilities`: feature gates used by host runtime before attaching hooks, plugins, spec server, remote spawn, or restricted tool access.
- `RuntimeHostServices`: Ravi-owned dynamic tools, command authorization, tool authorization, capability authorization, and user input.
- `RuntimeHostHooks`: provider-native hook adapter when supported.
- `RuntimeHostStreamingSession`: host-side live state for one session process/stream.
- `RuntimeEvent`: canonical event stream consumed by the Ravi host event loop.
- `RuntimeEventLoop`: canonical event consumer that emits NATS events, traces, tool events, responses, cost/tokens, provider state, and recovery prompts.

## Lifecycle

1. A channel, CLI, task, or system component publishes a prompt for a Ravi session.
2. The dispatcher decides whether to debounce, queue, interrupt, restart, defer after task, or cold-start.
3. The launcher resolves the session, agent, provider, runtime model/effort/thinking, source metadata, and stored provider state.
4. The launcher persists the inbound user message before provider handoff.
5. The request builder creates Ravi context/env, host services, provider bootstrap, session continuity, attachments, system prompt, and prompt generator.
6. The provider starts or resumes the native execution engine and emits canonical `RuntimeEvent` values.
7. The event loop emits runtime/tool/stream/response events, records traces, persists terminal state, and unblocks the prompt generator.
8. The prompt generator clears delivered messages only after a terminal non-interrupted turn.

## Invariants

- Providers MUST be adapters. They MUST NOT own Ravi sessions, routing, tasks, permissions, delivery, traces, or outbound channel responses.
- Provider-specific behavior MUST be selected through `RuntimeCapabilities` or provider-local adapter code. It MUST NOT leak into `bot.ts`, `session-launcher.ts`, or `runtime-request-builder.ts`.
- Every yielded provider turn MUST eventually produce exactly one terminal canonical event: `turn.complete`, `turn.failed`, or `turn.interrupted`.
- The prompt generator MUST set `turnActive` before yielding a provider prompt and MUST be signaled on every terminal event path.
- The event loop MUST persist provider session state only from canonical terminal state, not from raw provider events.
- User prompts MUST be saved before provider handoff; assistant messages MUST be saved only after a non-interrupted terminal turn.
- Tool start/end lifecycle MUST be recorded through canonical `tool.started` and `tool.completed` events.
- Runtime permissions MUST flow through Ravi host services or host hooks. Providers MUST NOT create a parallel permission model.
- `adapter.request` trace MUST be recorded before provider handoff, including prompt hashes, system prompt hashes, model, provider, resume/fork state, delivery barrier, source, and capability summary.
- Stalled-turn recovery MAY exist as a safety net, but it MUST NOT be the primary terminal-event mechanism.
- New providers MUST add provider contract tests, event normalization tests, and runtime capability matrix coverage before live use.

## Validation

- `bun test src/runtime/provider-contract.test.ts`
- `bun test src/runtime/session-dispatcher.test.ts src/runtime/delivery-queue.test.ts`
- `bun test src/runtime/session-trace.test.ts`
- `bun test src/runtime/runtime-session-continuity.test.ts src/runtime/session-resolver.test.ts`
- `bun test src/bot.runtime-guards.test.ts`
- `bunx tsc --noEmit --pretty false`
- `bun run build`

## Known Failure Modes

- A provider emits a tool result but no terminal event, leaving `turnActive` true until watchdog recovery.
- Raw provider keepalive/status events update `lastActivity` and mask a logically stuck turn.
- Multiple assistant messages in one turn are aggregated into one durable assistant message while also being emitted as separate responses; UI consumers can misread boundaries.
- Host tool tracking currently assumes one active tool at a time. Parallel provider tools would corrupt `currentToolId/currentToolName`.
- `RuntimeCapabilities` is too coarse for future providers: it lacks explicit fields for runtime control operations, dynamic tools, session storage mode, system prompt mode, usage semantics, and embedded-vs-subprocess lifecycle.
- Model catalog and provider options still contain provider-specific branches.
- Legacy event suffix support can keep transport/UI code coupled to old provider topic names.
- `prepareSession` is constrained to env/start-request fragments; embedded providers may need a more explicit bootstrap object for resource loaders, session managers, or native tool adapters.
- Tool failure recovery is heuristic and can mark a turn failed when the provider is still alive but not emitting the expected terminal event.
