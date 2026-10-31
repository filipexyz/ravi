---
id: runtime/start-admission
title: Runtime Start Admission
kind: capability
domain: runtime
capabilities:
  - start-admission
tags:
  - runtime
  - pool
  - presence
applies_to:
  - src/runtime/session-dispatcher.ts
  - src/runtime/session-pool.ts
  - src/runtime/start-admission.ts
  - src/runtime/start-admission-inbox.ts
  - src/runtime/prompt-subscription.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Start Admission

- A start with a free eligible slot MUST progress independently of any other session's start or turn. Reservation MUST be synchronous and counted before provider preparation yields.
- Under pressure, admission MUST evict least-recently-active non-serving sessions until the lane can admit the start. Idle TTL is a cache policy, not a minimum residency guarantee; disabling TTL MUST NOT disable pressure eviction.
- Starting sessions, active turns, tools, tool-result delivery, compaction, pending prompts/wakes, buffered debounce messages and stashed work MUST NOT be evicted as idle.
- Interactive reserved capacity MUST remain enforced. A full eligible lane MUST refuse immediately, with no new `pendingStarts` capacity entry.
- Refusal MUST expose lane, eligible/global limits, active/reserved counts, occupant session/agent/provider/state/inactivity, largest consumer by slot count, and queue position (null for immediate refusal) in internal telemetry. Other sessions' identities MUST NOT be disclosed to a chat user.
- Before ACKing refusal, the runtime MUST commit the complete original prompt envelope to the local inbox under an idempotent delivery key. A failed persistence MUST NOT ACK or claim preservation. A redelivery of an already retained transport delivery MUST NOT execute the prompt, even after process restart.
- The inbox receipt MUST be user-visible when there is a reply surface. It MUST say that an operator must free capacity and resume the saved request. Automatic retry MUST NOT be promised: the current `SESSION_PROMPTS` stream is memory-backed and expires at 60 seconds.
- Decision answers already have a durable admission receipt and retry scheduler. Capacity refusal MUST remain a verified pre-dispatch rejection in that ledger; the consumer MUST NOT add a second inbox recovery owner.
- Explicit operator resumption publishes a new transport delivery of the saved envelope; redelivery of the original receipt remains fenced. Saved content is data, never instructions to expand authority.
- Cold starts MUST NOT ACK a debounce buffer before admission. A refused attempt MUST restore any held skip-turn/bootstrap context it consumed while composing that attempt.
- Defensive queued-start expiry MUST reject to the transport caller, never resolve as successful acceptance. Its watchdog uses `RAVI_RUNTIME_PENDING_START_TIMEOUT_MS`, default 30 seconds, independently of idle TTL. This bounds anomalous waiting to one liveness interval rather than a cache residency window; it does not enable waiting for pool capacity.
- Receipt/presence MUST be emitted before waiting on a per-session dispatch tail, and MUST NOT require a pool slot. Refusal/failure MUST clear it. Background/skip-turn suppression remains enforced.
