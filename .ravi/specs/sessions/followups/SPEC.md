---
id: sessions/followups
title: Session Followups
kind: capability
domain: sessions
capability: followups
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/session-followups
  - src/cli/commands/session-followups.ts
  - src/daemon.ts
tags:
  - sessions
  - followups
  - routines
  - reading-lists
---

# Session Followups

## Intent

Session followups are durable inactivity cadences that inject compact reminder prompts into existing Ravi sessions. They exist for operational loops such as "if nobody answered in this group after two hours, remind the agent to follow up" where cron and heartbeat are the wrong abstraction because the clock must reset from conversation activity.

## Boundaries

- A followup cadence is not a route. It MUST NOT decide which agent owns a chat.
- A followup cadence is not a transport sender. It MUST inject prompts through the session prompt queue.
- A followup cadence is not a generic trigger subscription. Event triggers belong to `routines/triggers`.
- A followup cadence is not a heartbeat. Fixed liveness checks belong to `heartbeat`.
- A followup cadence is not a cron job. Fixed wall-clock schedules belong to `cron`.
- A followup cadence MAY use reading lists as the grouping primitive for chats/groups.
- A followup cadence MAY target a session directly, a single chat, or a chat reading list.
- A followup cadence MUST NOT attach, detach, mute, unmute, or otherwise rewire sessions as a side effect.

## Delivery

- The default delivery barrier MUST be `followup`, which resolves to `after_response`.
- `steer` MAY be selected explicitly for cadences that should enter after tool boundaries.
- Immediate interruption MUST be explicit and SHOULD be reserved for urgent operational policies.
- Followup prompts MUST use the runtime delivery queue. They MUST NOT directly call provider APIs.
- Chat targets SHOULD resolve delivery to the active attached session first.
- If the target chat has no active attached session, the runner MAY use an existing recent routed session whose persisted source points at the same chat/account.
- If multiple Ravi `chat` rows represent the same channel/platform chat id, the runner MUST prefer the row with an active subscription or valid recent routed session before falling back to recency.
- If the target chat has no active attached or recent routed session, the run MUST be skipped or failed with a clear reason instead of creating an implicit route.

## Cadence Shape

Each cadence SHOULD persist:

- `id`, `name`, optional `description`;
- owner scope (`owner_type`, `owner_id`);
- target type and reference (`session`, `chat`, `reading_list`);
- schedule:
  - `every` means "after target inactivity" inside this domain, not fixed interval cron semantics;
  - `at` and `cron` MAY exist for operational/manual compatibility, but SHOULD NOT be used when the desired behavior is silence-based follow-up;
- one or more followup steps for `every`, each with `afterMs` and message template;
- delivery barrier;
- message template;
- enabled/paused/snoozed state;
- last/next check timestamps;
- last status and sanitized error.

## Runs

- Each due cadence MUST create durable run rows before publishing prompts.
- Inactivity scheduled runs MUST be idempotent by cadence, activity anchor timestamp, step index, and resolved target.
- A cadence with multiple due steps SHOULD create only the next unsent step for a target in one sweep. It MUST NOT spam all overdue steps at once.
- A new external activity anchor MUST restart the step sequence for that target.
- Followup prompts and agent-authored messages MUST NOT advance the inactivity anchor.
- For chat and reading-list targets, the inactivity anchor SHOULD be the latest non-agent row in `chat_messages`.
- For direct session targets without an attached output chat, the inactivity anchor SHOULD be the latest persisted user message with external source provenance, such as `source_message_id`; generic session metadata updates MUST NOT count as activity.
- Runs MUST record status: `pending`, `leased`, `sent`, `skipped`, `failed`, or `dead`.
- Failed runs MAY be retried with backoff. Retrying MUST NOT duplicate an already sent idempotency key.
- Manual runs SHOULD use a distinct idempotency key so operators can test a cadence without consuming the scheduled occurrence.

## Prompt Contract

Followup prompts generated from cadences MUST be concise and human-readable. They MUST NOT dump raw JSON by default.

Standard header:

```text
[Session Followup: <cadence name> | Event: ravi.sessions.followup.due | Target: <session/chat/list target> | Step: <index>/<total> after <duration>]
<rendered message template>
```

The header MUST be a single line. Followups MUST NOT emit a multi-line metadata
block before the message.

Templates MAY reference safe variables such as:

- `{{data.cadence.id}}`
- `{{data.cadence.name}}`
- `{{data.target.type}}`
- `{{data.target.ref}}`
- `{{data.chat.id}}`
- `{{data.chat.title}}`
- `{{data.schedule.dueAt}}`
- `{{data.activity.anchorAt}}`
- `{{data.step.index}}`
- `{{data.step.after}}`

## Events

The system SHOULD emit best-effort audit events:

- `ravi.sessions.followup.due`
- `ravi.sessions.followup.sent`
- `ravi.sessions.followup.skipped`
- `ravi.sessions.followup.failed`

These events are for observability and downstream triggers. They MUST NOT be the primary delivery mechanism.

## CLI

The CLI SHOULD expose:

- `ravi sessions followups list`
- `ravi sessions followups add`
- `ravi sessions followups inspect <id>`
- `ravi sessions followups run <id>`
- `ravi sessions followups pause <id>`
- `ravi sessions followups resume <id>`
- `ravi sessions followups snooze <id> --until <iso>`
- `ravi sessions followups retry [id]`

All commands that return state MUST support `--json`.

CLI semantics:

- `--every <duration> --message <text>` creates a single inactivity step.
- `--step "<duration>=<message>"` MAY be repeated to create progressive followups, e.g. `--step "2h=First followup" --step "3h=Second followup"`.
- `--step` MUST NOT be combined with `--every`, `--at`, or `--cron`.

## Acceptance Criteria

- Creating an inactivity cadence persists a durable row with explicit steps and a `nextRunAt` check time.
- Creating the same scheduled run twice does not duplicate prompts.
- A due session cadence publishes a prompt with `deliveryBarrier=after_response`.
- A chat cadence resolves the active attached session for that chat.
- A reading-list cadence expands to one run per active member chat.
- A chat/list cadence anchors inactivity on the last non-agent chat message.
- Progressive steps fire one at a time and reset when a new external chat message appears.
- A chat/list target with no attached session records a skipped run instead of creating a route.
- `ravi sessions followups list --json` returns pagination-ready machine-readable state.
- The runner is best-effort and must not prevent daemon startup if a cadence fails.
