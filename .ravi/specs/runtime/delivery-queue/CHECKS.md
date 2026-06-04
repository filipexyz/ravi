# Runtime Delivery Queue Checks

## Defaults

- `sessions send` defaults to `after_response`.
- `sessions send --steer` maps to `after_tool`.
- `--barrier followup` maps to `after_response`.
- `--barrier steer` maps to `after_tool`.
- `sessions notify` or equivalent notification commands default to `after_response`.
- `sessions inform` defaults to `after_response`.
- `sessions ask` defaults to `after_response`.
- `sessions answer` defaults to `after_response` unless an explicit immediate/unblock path is used and traced.
- `sessions execute` defaults to `after_task`.
- Cron jobs in shared sessions default to `after_response`.
- Cron jobs that intentionally act as task/supervisor work set `after_task` explicitly.
- Daemon restart resume notices default to `after_response`.
- Hook `inject_context` and `send_session_event` default to `after_response`.
- Trigger and heartbeat runners remain `after_task`.
- Task dispatch/resume keeps `after_task`; task comment/report steering keeps `after_response`.
- Human channel input keeps the documented live-interrupt behavior.
- Generic external producers do not rely on the global fallback.

## Interrupt Safety

- `after_response` / `followup` never calls provider interrupt during text generation.
- `after_task` never calls provider interrupt during text generation or active task work.
- `after_tool` / `steer` waits for startup, compaction, and tool barriers before interrupting.
- `immediate_interrupt` still respects startup, compaction, and unsafe tool barriers.

## Queue Integrity

- Pending prompt atoms keep source, context, pending id, barrier, queue time, task barrier metadata, and launch metadata.
- Same-lane prompt atoms are delivered FIFO.
- Bypassing a blocked prompt atom is traceable.
- Batched prompt atoms keep their internal order.
- Daemon restart resume preserves queued prompt atoms.

## Observability

- Publish traces include delivery barrier and explicit/default/inferred classification.
- Queue traces include blocked reason and queue size.
- Interrupt traces include source and barrier.
- Terminal turn traces show whether the previous turn completed, failed, or was interrupted.

## Regression Tests

- External follow-up arrives during active text generation and waits for turn completion.
- External immediate arrives during active text generation and interrupts once safe.
- External follow-up arrives while a tool is running and waits.
- Immediate arrives while an unsafe tool is running and waits.
- Operational event arrives during active task and waits for the task barrier.
- Human channel input arrives during active text generation and can interrupt after safe barriers.
- Edited-message rebase prompt can interrupt as a documented exception.
