---
title: Session Trace v1
description: Canonical SQLite-backed ledger for inspecting every meaningful event in a Ravi session.
---

Session Trace v1 is the canonical inspection layer for Ravi sessions. It lets an
operator reconstruct a session from SQLite without reading daemon logs or NATS
history.

Use it when a session received a message but did not answer, answered the wrong
target, lost context, timed out, was aborted, dropped delivery, or behaved
differently after a model/provider/settings change.

## Source of Truth

SQLite is the source of truth for session inspection.

- Trace rows live in `ravi.db`, alongside the existing session runtime state.
- NATS remains transport, live fanout, and replay/debug infrastructure.
- `ravi sessions debug` is useful while the runtime is live, but it is not the
  canonical incident record.
- Daemon logs can add process-level detail, but an operator should not need them
  to understand the normal session path.

The default operator path is:

```bash
ravi sessions trace <session> --since 2h --explain
```

## Data Model

### `session_events`

Append-only event ledger for things that happen inside or around a session.

Important columns:

- `session_key`, `session_name`, `agent_id`
- `run_id`, `turn_id`, `seq`
- `event_type`, `event_group`, `status`
- `timestamp`, `duration_ms`
- `source_channel`, `source_account_id`, `source_chat_id`,
  `source_thread_id`, `message_id`
- `provider`, `model`
- `payload_json`, `preview`, `error`

Useful indexes are present for session/time, run/seq, turn/seq, event type, and
source chat lookup.

### `session_turns`

Per-turn read model. It is updated when a turn starts at the adapter boundary
and when a terminal state is observed.

Important fields:

- `turn_id`, `run_id`, `session_key`, `session_name`, `agent_id`
- `provider`, `model`, `effort`, `thinking`, `cwd`
- `status`, `resume`, `fork`
- `provider_session_id_before`, `provider_session_id_after`
- `user_prompt_sha256`, `system_prompt_sha256`, `request_blob_sha256`
- token and cost counters
- `error`, `abort_reason`, `started_at`, `completed_at`, `updated_at`

`session_turns` is the quickest way to answer whether a provider request reached
a terminal state.

### `session_trace_blobs`

Content-addressed storage for large trace payloads.

Blob kinds currently used by the trace layer:

- `system_prompt`
- `user_prompt`
- `adapter_request`
- `tool_input`
- `tool_output`
- `provider_event`

Prompt and request blobs are deduplicated by SHA-256. Default CLI output shows
hashes, sizes, sections, and previews. Full prompt or request contents only
print when explicitly requested.

## Event Taxonomy

The implemented SQLite trace uses these event groups:

- `channel`
- `routing`
- `prompt`
- `dispatch`
- `runtime`
- `adapter`
- `tool`
- `approval`
- `response`
- `delivery`
- `session`

The event types currently recorded by the Session Trace v1 implementation are:

| Event type | Group | Meaning |
| --- | --- | --- |
| `channel.message.received` | `channel` | Omni inbound message was accepted and normalized for a resolved session. |
| `route.resolved` | `routing` | Contact/route/session resolution selected a session and agent. |
| `prompt.published` | `prompt` | A prompt was published to the session prompt stream. |
| `dispatch.cold_start` | `dispatch` | Runtime dispatcher chose to start a new streaming session. |
| `dispatch.push_existing` | `dispatch` | Incoming message was queued onto an existing streaming session. |
| `dispatch.queued_busy` | `dispatch` | Message or session start was queued because the runtime was busy, blocked by barrier, or concurrency-limited. |
| `dispatch.interrupt_requested` | `dispatch` | Dispatcher asked the provider/runtime to interrupt the current turn for a new message. |
| `dispatch.deferred_after_task` | `dispatch` | Cold start was deferred behind an active task barrier. |
| `dispatch.restart_requested` | `dispatch` | Runtime session restart was requested because identity, provider, model, or task runtime settings changed. |
| `runtime.start` | `runtime` | Runtime session startup began or failed. |
| `runtime.status` | `runtime` | Runtime status update such as compaction state. |
| `adapter.request` | `adapter` | Final provider request was built at the Ravi boundary. This is the primary turn start event. |
| `adapter.raw` | `stream` | Legacy raw adapter/provider lifecycle event. New runtime turns do not persist raw lifecycle rows in SQLite. |
| `tool.start` | `tool` | Provider reported a tool call start. |
| `tool.end` | `tool` | Provider reported a tool call completion or failure. |
| `assistant.message` | `response` | Provider produced assistant text before outbound emission. |
| `response.emitted` | `response` | Ravi emitted a response onto the response bus for delivery. |
| `delivery.delivered` | `delivery` | Gateway observed successful outbound delivery. |
| `delivery.failed` | `delivery` | Gateway observed outbound delivery failure. |
| `delivery.dropped` | `delivery` | Gateway intentionally dropped outbound delivery, for example missing target. |
| `delivery.observed` | `delivery` | Gateway observed an outbound status not mapped to delivered/failed/dropped. |
| `turn.complete` | `runtime` | Turn completed normally and token/cost/session state was recorded. |
| `turn.failed` | `runtime` | Turn failed and the error was recorded. |
| `turn.interrupted` | `runtime` | Turn was interrupted, aborted, timed out, or recoverably stopped before normal completion. |
| `session.abort` | `session` | Session abort was requested, deferred, or executed. |
| `session.timeout` | `session` | Runtime idle timeout fired. |
| `session.model_changed` | `session` | Live model change was applied without full restart. |

`prompt.received` is still emitted as a live runtime audit event when the prompt
stream consumer receives a message, but it is not currently a persisted SQLite
trace event. Use `ravi sessions debug <session>` only when you need that live
transport-level signal.

Approval events can appear in provider/runtime streams and live debug output.
The v1 SQLite trace keeps the group in the taxonomy so approval persistence can
use the same query/explain path when the host approval bridge records it.

## `adapter.request`

`adapter.request` is the most important trace event. It is recorded after Ravi
has resolved session, runtime, task options, context, tools, plugins, prompts,
resume/fork continuity, and environment metadata, but before the provider
adapter receives the final request.

It records:

- `run_id`, `turn_id`, `session_key`, `session_name`, `agent_id`
- `provider`, `model`, `effort`, `thinking`, `cwd`
- `resume`, `fork`, `provider_session_id_before`
- `context_id`
- normalized source target and delivery barrier
- `task_barrier_task_id`
- `system_prompt_sha256`, `system_prompt_chars`,
  `system_prompt_sections`
- `user_prompt_sha256`, `user_prompt_chars`
- `request_blob_sha256`
- `settings_sources`
- `has_hooks`
- `plugin_count`, `plugin_names`
- `mcp_server_names`
- `has_remote_spawn`
- `tool_access_mode`
- `capability_summary`
- `queued_message_count`, `pending_ids`

Default human output shows the hashes and a short user prompt preview. Use
explicit flags to print larger payloads:

```bash
ravi sessions trace <session> --turn <turn_id> --show-system-prompt
ravi sessions trace <session> --turn <turn_id> --show-user-prompt
ravi sessions trace <session> --turn <turn_id> --raw
```

## CLI Surface

Primary command:

```bash
ravi sessions trace <session> --since 2h --explain
```

Useful filters:

```bash
ravi sessions trace <session> --since 30m
ravi sessions trace <session> --since 30m --limit 40
ravi sessions trace <session> --until 2026-04-19T15:30:00.000Z
ravi sessions trace <session> --turn <turn_id>
ravi sessions trace <session> --run <run_id>
ravi sessions trace <session> --message <source_message_id>
ravi sessions trace <session> --correlation <request_or_correlation_id>
```

Useful views:

```bash
ravi sessions trace <session> --only adapter
ravi sessions trace <session> --only tools
ravi sessions trace <session> --only delivery
ravi sessions trace <session> --only turn
ravi sessions trace <session> --only adapter.request
ravi sessions trace <session> --json
```

Payload controls:

```bash
ravi sessions trace <session> --raw
ravi sessions trace <session> --show-system-prompt
ravi sessions trace <session> --show-user-prompt
```

Time values accept:

- relative durations: `30m`, `2h`, `1d`
- epoch milliseconds
- ISO timestamps

Use placeholders in examples and runbooks. Do not paste real customer chat IDs,
phone numbers, prompt contents, tokens, context keys, or provider session IDs
into docs or issues.

## Human Output

Human output is chronological and intentionally compact:

```text
Session trace: <session-name>
Agent: <agent-id>
Runtime: provider=<provider> model=<model> cwd=<cwd>
Route: <channel>/<account>/<chat>
Window: since <timestamp>
Rows: events=<n> turns=<n>

14:10:01.100 channel.message.received
  source=whatsapp/<account>/<chat> messageId=<source-message-id>
  preview="..."

14:10:01.150 prompt.published
  source=whatsapp/<account>/<chat> messageId=<source-message-id>
  preview="..."

14:10:02.000 adapter.request
  run=<run-id> turn=<turn-id> status=built provider=codex model=gpt-5.4
  resume=true fork=false
  cwd=<worktree>
  systemPrompt=sha256:<hash> chars=<n> sections=Identity,System Commands,Runtime
  userPrompt=sha256:<hash> chars=<n> preview="..."

14:10:07.500 tool.start
  run=<run-id> turn=<turn-id> status=running provider=codex model=gpt-5.4
  preview="Bash"

14:10:08.010 tool.end
  run=<run-id> turn=<turn-id> status=complete provider=codex model=gpt-5.4 duration=510ms
  preview="Bash"

14:10:13.300 response.emitted
  source=whatsapp/<account>/<chat> messageId=<source-message-id>
  preview="..."

14:10:13.900 delivery.delivered
  source=whatsapp/<account>/<chat> messageId=<source-message-id> duration=600ms
  preview="<outbound-message-id>"

14:10:14.000 turn.complete
  run=<run-id> turn=<turn-id> status=complete provider=codex model=gpt-5.4 duration=12000ms
```

If a trace has an `adapter.request` event, the turn reached the provider
boundary. If it does not, inspect channel, routing, prompt, dispatch, task
barrier, and runtime startup rows before assuming provider failure.

## `--json`

`--json` prints JSONL records:

- one `metadata` record
- chronological `event` and `turn` records
- requested `blob` records
- one `explanation` record when `--explain` is also used

This is the safest format for scripts:

```bash
ravi sessions trace <session> --since 2h --json --explain
```

## `--explain`

`--explain` derives common incident patterns from the SQLite trace and prints
findings ordered by severity.

Current finding codes:

| Code | Meaning | Usual next read |
| --- | --- | --- |
| `prompt-without-adapter-request` | Prompt event exists but no later `adapter.request` was found in the same prompt window. | Check `dispatch.*`, task barrier, debounce, runtime startup. |
| `adapter-request-without-terminal-turn` | Provider request was built but no terminal event or terminal turn snapshot exists. | Check provider process exit, timeout, lost runtime events. |
| `response-without-delivery` | Assistant response was emitted but no delivery event followed. | Check `delivery.*`, target routing, gateway/outbound state. |
| `delivery-failed` | Gateway recorded failed delivery. | Read delivery error/payload and channel instance status/config. |
| `delivery-dropped` | Gateway intentionally dropped the response. | Usually missing target or channel routing issue. |
| `interruption-or-abort` | Interrupt, abort, or interrupted turn was observed. | Read `session.abort`, `dispatch.interrupt_requested`, and `turn.interrupted`. |
| `timeout` | Session idle timeout or turn timeout state was observed. | Check `session.timeout`, turn `abortReason`, and prior tool/runtime rows. |
| `resume-disabled-with-provider-session` | Resume was false despite an existing provider session id. | Inspect provider continuity, reset/delete/model/provider changes. |
| `tool-start-without-end` | Tool started but no matching `tool.end` was recorded. | Check interruption, unsafe deferred abort, adapter stream loss. |
| `prompt-held-by-task-barrier` | A prompt/request carried `taskBarrierTaskId`. | Inspect the linked task and after-task delivery barrier. |
| `debounce-merged-messages` | Debounce or queued message merge affected the prompt. | Read `queued_message_count`, `pending_ids`, and user prompt blob. |
| `model-provider-changed` | Model/provider changed during the trace window. | Compare `runtime.start`, `adapter.request`, turn snapshots. |
| `system-prompt-changed` | More than one system prompt hash was observed. | Compare turns with `--show-system-prompt`. |

An `attention` status means at least one finding matched. It is not always a
bug. Info findings often explain intentional behavior such as task barriers,
debounce, or model changes.

## Operator Workflow

### 1. Find the session

Use the session name if you have it:

```bash
ravi sessions list
ravi sessions info <session>
```

If the report came from a channel, use known route metadata to identify the
session. Do not paste real phone numbers or group IDs into shared docs.

### 2. Read the last two hours with explanations

```bash
ravi sessions trace <session> --since 2h --explain
```

Read top to bottom:

1. `channel.message.received`: inbound reached Ravi.
2. `route.resolved`: route selected the expected session and agent.
3. `prompt.published`: prompt was placed on the session prompt stream.
4. `dispatch.*`: dispatcher decision, queue, interrupt, restart, or barrier.
5. `runtime.start`: runtime session startup.
6. `adapter.request`: final provider request and prompt hashes.
7. `tool.*` and `assistant.message`: provider-side work.
8. `response.emitted`: Ravi emitted text to the gateway.
9. `delivery.*`: final channel delivery observation.
10. `turn.*` or `turn.snapshot`: terminal state and token/cost/context data.

### 3. Narrow to the failing turn

If the output includes a suspicious `turn=<turn-id>`:

```bash
ravi sessions trace <session> --turn <turn_id> --explain
```

If a channel message id is known:

```bash
ravi sessions trace <session> --message <source_message_id> --explain
```

If a provider/request/correlation id is present in payloads:

```bash
ravi sessions trace <session> --correlation <correlation_id> --raw --explain
```

### 4. Inspect prompt or request payload only when needed

Use hashes first. Print full blobs only for a specific turn and only in a local
operator context:

```bash
ravi sessions trace <session> --turn <turn_id> --show-user-prompt
ravi sessions trace <session> --turn <turn_id> --show-system-prompt
ravi sessions trace <session> --turn <turn_id> --raw
```

### 5. Decide the failure class

- No `channel.message.received`: inbound did not reach Ravi or the trace window
  is wrong.
- `channel.message.received` but no `route.resolved`: routing/contact stage.
- `route.resolved` but no `prompt.published`: publish/session stream stage.
- `prompt.published` but no `adapter.request`: dispatch, task barrier, debounce,
  concurrency, or runtime startup.
- `adapter.request` but no terminal turn: provider/runtime after handoff.
- `assistant.message` but no `response.emitted`: response suppression,
  interruption, or silent/no-response behavior.
- `response.emitted` but no `delivery.*`: gateway/outbound observation gap.
- `delivery.failed` or `delivery.dropped`: channel delivery issue or missing
  target.
- `turn.interrupted`, `session.abort`, or `session.timeout`: read `abortReason`,
  status, queue, and prior tool rows.

## Golden Path: SDE Incident

Scenario: an operator receives "the agent saw my message but did not reply".

Use safe placeholders:

```bash
ravi sessions trace <session> --since 2h --explain
```

If `--explain` prints `prompt-without-adapter-request`, inspect dispatch:

```bash
ravi sessions trace <session> --since 2h --only dispatch --explain
```

Common reads:

- `dispatch.deferred_after_task` means the prompt was held behind an active task.
  Check the task id shown in `taskBarrierTaskId`.
- `dispatch.queued_busy` with `reason=waiting_for_barrier` means the runtime was
  alive but the message did not meet the current delivery barrier.
- `dispatch.queued_busy` with `reason=concurrency_limit` means session startup
  waited behind `maxConcurrentSessions`.
- `dispatch.restart_requested` means Ravi intentionally restarted before the next
  turn because model/provider/agent/task runtime settings changed.

If `--explain` prints `adapter-request-without-terminal-turn`, inspect the turn:

```bash
ravi sessions trace <session> --turn <turn_id> --explain
```

Common reads:

- `runtime.status status=compacting` before the gap suggests context compaction.
- `session.timeout` means the idle watchdog aborted the runtime.
- `tool.start` without `tool.end` suggests interruption during tool execution or
  missing provider completion event.

If `--explain` prints `response-without-delivery`:

```bash
ravi sessions trace <session> --turn <turn_id> --only delivery --explain
```

Common reads:

- No delivery rows: gateway did not observe a final outbound status in the trace.
- `delivery.dropped` with `reason=missing_target`: response had no channel target.
- `delivery.failed`: inspect `error`, `reason`, `instanceId`, and channel chat id
  in the delivery payload.

## Abort and Context Loss

Use these cues for context loss and abort reports:

- `resume=false` plus `provider_session_id_before=<id>` is suspicious unless a
  reset, delete, fork, model/provider switch, or capability limitation explains
  it.
- `provider_session_id_after` changing on `turn.complete` is normal when the
  provider returns an updated session handle.
- `system-prompt-changed` is informational. It means the Ravi-built system prompt
  hash changed across turns; compare only the specific turns that matter.
- `session.abort` with `status=deferred` means an unsafe tool was running and the
  abort was postponed until the tool completed.
- `turn.interrupted` with `abortReason=explicit_abort`, `model_change_restart`,
  `provider_change`, `agent_change`, `runtime_task_settings_change`, or
  `idle_timeout` explains why the turn stopped before normal completion.

## Redaction and Safety

Session Trace v1 is local operator infrastructure, but docs and issue reports
must still avoid sensitive values.

Do not include real:

- phone numbers, group ids, chat ids, thread ids
- user prompts or customer content
- provider session ids
- context keys
- API keys, tokens, cookies, auth headers
- private config values

Safe to include in most engineering notes:

- event type and group
- relative order
- placeholder ids such as `<session>`, `<turn_id>`, `<message_id>`
- hash prefixes such as `sha256:<prefix>`
- status, duration, token counts, and non-sensitive error class

When sharing `--explain` output, keep the finding code/title/detail and replace
real ids with placeholders. Local operator output can contain enough metadata to
debug the incident; shared issue text should not.

## Validation

Useful validation commands for this feature:

```bash
ravi sessions trace --help
bun test src/session-trace/
bun test src/cli/commands/sessions-trace.test.ts
bun test src/runtime/session-trace.test.ts src/gateway-session-trace.test.ts
```

Do not restart the daemon just to validate trace docs or CLI help. Use the source
wrapper from the repo when checking the local working tree:

```bash
./bin/ravi sessions trace --help
```
