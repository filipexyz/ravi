# Runtime Delivery Queue Runbook

## When To Use

Use this runbook when:

- a session stops mid-response after another event arrives;
- a `sessions send`, notification, hook, trigger, cron job, observer event, or answer appears to cut ongoing work;
- an urgent event did not interrupt when it should have;
- queued follow-up messages appear out of order.

## First Checks

Identify the prompt atom or event that arrived during the active turn.

Check these fields in trace/logs:

- session name/key;
- prompt source;
- `deliveryBarrier`;
- whether the barrier was explicit or inferred;
- queue size before/after;
- `dispatch.queued_busy`;
- `dispatch.interrupt_requested`;
- provider terminal event for the previous turn.

If an external session event interrupted a text response and did not carry explicit immediate intent, treat it as a bug.

## Barrier Diagnosis

- `immediate_interrupt`: should interrupt only after startup, compaction, and unsafe tool barriers clear.
- `after_tool` / `steer`: may interrupt text generation after tool barriers. This should mostly be human channel input or explicit steer behavior.
- `after_response` / `followup`: should wait for the current response to become terminal.
- `after_task`: should wait for the current response and active task barrier to finish.

If a producer is generic automation and it uses `after_tool`, change the producer default to `after_response`.

If a producer must support active-turn delivery, add or use explicit `steer` delivery instead of changing the default.

If a producer must preempt as soon as safe, add or use explicit `immediate` delivery instead of changing the default.

## Producer Review

For every `publishSessionPrompt` call, answer:

1. Is this human channel input?
2. Is this an external session/system event?
3. Is it operational task work?
4. Does it require immediate interruption, or can it wait for the current response?
5. Does it pass explicit `deliveryBarrier`, or rely on inference?

External events should either pass `deliveryBarrier: "after_response"` or be inferable as `after_response`.

Operational task/supervisor events should use `after_task` when they should not disturb active work.

## Known Producer Audit

Audit every `publishSessionPrompt` caller before changing delivery behavior:

| Producer | Expected default | Notes |
| --- | --- | --- |
| `sessions send` | `after_response` / `followup` | Generic cross-session message. `steer` or `immediate` must be opt-in. |
| `sessions ask` | `after_response` | Question delivery should not cut current work. |
| `sessions answer` | `after_response` | Immediate only for explicit/unblock paths. |
| `sessions inform` | `after_response` | Informational follow-up. |
| `sessions execute` | `after_task` | Operational command. |
| `cron runner` | `after_response` | Scheduled prompt is external; use `after_task` only for task/supervisor jobs. |
| `trigger runner` | `after_task` | Current `_trigger` metadata maps here. |
| `heartbeat runner` | `after_task` | Current `_heartbeat` metadata maps here. |
| `hooks inject_context` | `after_response` | It is rendered as `[System] Inform`. |
| `hooks send_session_event` | `after_response` | Raw message payload must not fall through to `after_tool`. |
| `daemon restart resume` | `after_response` | Must be explicit or recognized by metadata. |
| `task dispatch/resume` | `after_task` | Existing task barrier must be preserved. |
| `task report/comment steer` | `after_response` | Follow-up to a session, not interruption. |
| `human channel inbound` | `after_tool` | Live user intent can preempt after safe barriers. |
| `urgent human/edit rebase` | `immediate_interrupt` | Documented exception. |
| `TUI user input` | `after_tool` | Treat as operator-authored input if source is explicit. |
| `eval runner` | explicit | Test harness should not depend on fallback semantics. |

## Regression Scenarios

### Cross-Session Followup

1. Start a session turn that produces a long text response.
2. While it is generating, send a cross-session message with default delivery.
3. Expected: the target session does not receive an interrupt request.
4. Expected: the cross-session message is processed as the next turn.

### Explicit Steer

1. Start a session turn that produces a long text response.
2. Send a cross-session message with explicit steer delivery.
3. Expected: the dispatcher emits an interrupt request once safe.
4. Expected: trace shows steer was explicit and maps to `after_tool`.

### Explicit Immediate

1. Start a session turn that produces a long text response.
2. Send a cross-session message with explicit immediate delivery.
3. Expected: the dispatcher emits an interrupt request once safe.
4. Expected: trace shows immediate was explicit and maps to `immediate_interrupt`.

### Active Task

1. Run a task-bound session.
2. Deliver a heartbeat/execute/checkpoint event.
3. Expected: it waits behind `after_task` while the task barrier is active.

### Human Channel Input

1. Start a long assistant response.
2. Send a real human message in the channel.
3. Expected: the message may interrupt after safe tool barriers, unless configured otherwise.

## Validation Commands

```bash
bun test src/runtime/delivery-queue.test.ts
bun test src/runtime/session-dispatcher.test.ts
bun test src/cli/commands/sessions.test.ts
bun test src/session-trace/channel-trace.test.ts
bun run build
```

Run the narrower tests first when changing defaults, then the build.
