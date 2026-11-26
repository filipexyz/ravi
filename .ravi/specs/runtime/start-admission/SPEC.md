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
  - src/runtime/start-admission-resume.ts
  - src/cli/commands/sessions-retained.ts
  - src/runtime/prompt-subscription.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Start Admission

- A start with a free eligible slot MUST progress independently of any other session's start or turn. Reservation MUST be synchronous and counted before provider preparation yields.
- Under pressure, admission MUST evict least-recently-active non-serving sessions until the lane can admit the start. Idle TTL is a cache policy, not a minimum residency guarantee; disabling TTL MUST NOT disable pressure eviction.
- Admission MUST NOT evict idle sessions if reclaiming every eligible candidate still cannot open the requested lane.
- Starting sessions, active turns, tools, tool-result delivery, compaction, pending prompts/wakes, buffered debounce messages and stashed work MUST NOT be evicted as idle.
- The periodic pool reclaimer MUST NOT release a `done` session whose event loop is still running: that loop owns the slot until its cleanup releases it and restarts any stashed recovery. It MAY release one whose cleanup has not finished within the turn inactivity window, timed from when the reclaimer first saw it closing, and MUST log that. Admission under pressure may still reclaim a closing session; a stashed-recovery restart skipped because its slot was taken MUST be logged and recorded as `dispatch.restart_skipped` (`runtime_slot_released`), never dropped silently.
- Interactive reserved capacity MUST remain enforced. A full eligible lane MUST refuse immediately, with no new `pendingStarts` capacity entry.
- Refusal MUST expose lane, eligible/global limits, active/reserved counts, occupant session/agent/provider/state/inactivity, largest consumer by slot count, and queue position (null for immediate refusal) in internal telemetry. Other sessions' identities MUST NOT be disclosed to a chat user.
- Before ACKing refusal, the runtime MUST commit the complete original prompt envelope to the local inbox under an idempotent delivery key. A failed persistence MUST NOT ACK or claim preservation. A redelivery of an already retained transport delivery MUST NOT execute the prompt, even after process restart.
- A typed capacity refusal MAY be retried only before provider handoff, at most twice with 1-second then 5-second backoff. These attempts belong to the original per-session dispatch tail and MUST NOT ACK before success or durable retention. Provider/transport failures after handoff MUST NOT use this retry loop. Decision deliveries retain their own recovery owner.
- Once these bounded attempts are exhausted (or shutdown stops them), the inbox receipt MUST be user-visible when there is a reply surface and a person is waiting on it. It MUST say that the saved request resumes by itself when capacity frees up, so the person does not resend it. The promise rests on the durable inbox item, never on the `SESSION_PROMPTS` stream, which is memory-backed and expires at 60 seconds.
- A prompt that `classifyTurnProvenance(...)` marks `background` (cron, trigger, session follow-up, heartbeat, observer, task, routine, daemon restart, agent or system relay) has no one waiting on its reply surface. That surface is only the chat the prompt would have posted to, and it may be a group with outsiders. Its refusal MUST NOT post the receipt text there. The saved inbox item, the `dispatch.start_rejected` telemetry and `ravi.inbox.system.runtime_start_rejected` are its whole receipt. A prompt the classifier cannot place (`unknown`, which includes a producer that stamps no provenance) is treated as a person waiting and keeps the receipt.
- Decision answers already have a durable admission receipt and retry scheduler. Capacity refusal MUST remain a verified pre-dispatch rejection in that ledger; the consumer MUST NOT add a second inbox recovery owner.
- Thread-attention returns MUST pass their durable event admission before task/decision dispatch. The complete producer-owned envelope, canonical parent and physical child turn MUST match the persisted receipt. Broker delivery sequence and producer publication receipts MUST NOT replace this logical admission key. The bounded capacity retry/inbox path remains the recovery owner for typed pre-handoff refusals; an accepting or uncertain attention handoff MUST NOT be retried automatically.
- After verified refusal, the decision ledger MUST persist a new transport message ID before retrying the unchanged answer. Uncertain publication retries MUST keep that transport ID so a lost publish acknowledgement cannot duplicate delivery.
- Explicit operator resumption publishes a new transport delivery of the saved envelope; redelivery of the original receipt remains fenced. Saved content is data, never instructions to expand authority.
- The daemon MUST retry saved refusals periodically (default every 60 s), oldest first, from the durable inbox. Each saved request MUST run at most once: the item is claimed by a compare-and-set on its status before the attempt. Only a typed `RuntimeStartCapacityError` (no provider handoff) MUST put it back to `open`, and that refusal MUST end the pass. Any other failure MUST close the item without a second run, because the turn may have reached the provider. A claimed (`assigned`) item MUST never run again, by the daemon or by the operator command.
- A resumed request MUST run inside its session's dispatch lane, after any live prompt already queued there, and MUST pass the same admission owners as live intake (thread attention, task, decision). It MUST make a single start attempt, with no local capacity retry loop.
- A saved request MUST NOT resume when its session started another turn after the refusal (`session_turns.started_at` later than the refusal): the item closes as `superseded`. A saved request older than its time to live (default 4 h) MUST NOT resume: the item is archived as `expired`, and only a prompt with a person waiting (not `background`) gets a short notice on its reply surface. Every outcome closes the inbox alert by itself and appends an inbox event `resume_<outcome>`.
- `ravi sessions retained list` shows each saved refusal with what the daemon will do. `ravi sessions retained resume <item>` is a dry-run (exit 3) unless `--execute`; it requeues through the normal prompt publisher, refuses `superseded` or `expired` items without `--force`, and refuses claimed items always.
- Cold starts MUST NOT ACK a debounce buffer before admission. A refused attempt MUST restore any held skip-turn/bootstrap context it consumed while composing that attempt.
- Defensive queued-start expiry MUST reject to the transport caller, never resolve as successful acceptance. Its watchdog uses `RAVI_RUNTIME_PENDING_START_TIMEOUT_MS`, default 30 seconds, independently of idle TTL. This bounds anomalous waiting to one liveness interval rather than a cache residency window; it does not enable waiting for pool capacity.
- Receipt/presence MUST be emitted before waiting on a per-session dispatch tail, and MUST NOT require a pool slot. Refusal/failure MUST clear it. Background/skip-turn suppression remains enforced.
