---
id: events/gap-analysis
title: "Event Gap Analysis"
kind: capability
domain: events
capability: gap-analysis
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/events/audit-stream.ts
  - src/triggers/topic-catalog.ts
  - src/nats.ts
tags:
  - events
  - nats
  - audit
  - triggers
  - gap-analysis
related_specs:
  - routines/triggers
  - runtime/observation-plane
  - sessions
  - sessions/attach
  - agents
  - permissions
  - runtime
  - tasks
  - channels
  - contacts
  - artifacts
---

# Event Gap Analysis

## Intent

This spec identifies concrete gaps between the lifecycle events that Ravi domains produce and the canonical event subjects that the audit stream captures, the trigger topic catalog exposes, and related specs reference. The goal is a prioritized, actionable matrix of missing events so that follow-up implementation tasks can be scoped, reviewed, and scheduled by a human.

This spec is research only. It MUST NOT implement new publishers, change runtime behavior, add migrations, backfill history, or emit new events.

## Methodology

The analysis cross-references four sources:

1. **Actual publishers** — every `nats.emit()` / `publish()` call under `src/`.
2. **Audit stream** — the `RAVI_EVENTS_SUBJECTS` array in `src/events/audit-stream.ts`.
3. **Trigger topic catalog** — the `TOPICS` array in `src/triggers/topic-catalog.ts`.
4. **Related specs** — lifecycle events referenced or implied by specs for `sessions`, `sessions/attach`, `permissions`, `routines/triggers`, `runtime/observation-plane`, `tasks`, `channels`, `contacts`, and `artifacts`.

A gap exists when a domain performs a lifecycle mutation or policy decision without emitting a corresponding canonical event, or when an emitted event is missing from the audit stream or trigger catalog.

## Existing Coverage Summary

### Audit Stream (`RAVI_EVENTS`)

The `RAVI_EVENTS` JetStream stream captures:

| Subject pattern | Domain |
|---|---|
| `ravi.session.*.response` | runtime |
| `ravi.session.*.runtime` | runtime |
| `ravi.session.*.claude` | runtime |
| `ravi.session.*.tool` | runtime |
| `ravi.session.*.stream` | runtime |
| `ravi.session.*.delivery` | runtime |
| `ravi.session.*.adapter.>` | runtime |
| `ravi.session.abort` | sessions |
| `ravi.session.reset.requested` | sessions |
| `ravi.session.reset.completed` | sessions |
| `ravi.session.delete.requested` | sessions |
| `ravi.session.delete.completed` | sessions |
| `ravi.session.model.changed` | sessions |
| `ravi.session.runtime.control` | runtime |
| `ravi.approval.>` | approval |
| `ravi.audit.>` | permissions |
| `ravi.inbound.>` | inbound |
| `ravi.outbound.>` | delivery |
| `ravi.media.send` | delivery |
| `ravi.stickers.send` | delivery |
| `ravi.contacts.>` | contacts |
| `ravi.instances.>` | instances |
| `ravi.whatsapp.>` | channels |
| `ravi.config.changed` | config |
| `ravi.triggers.>` | triggers |
| `ravi.sessions.followup.>` | sessions |
| `ravi.cron.>` | cron |
| `ravi.heartbeat.>` | heartbeat |
| `ravi._cli.cli.>` | cli-audit |

### Trigger Topic Catalog

The trigger topic catalog exposes these subjects for routine consumption:

| Catalog ID | Subject | Category |
|---|---|---|
| `inbound.reaction` | `ravi.inbound.reaction` | inbound |
| `inbound.reply` | `ravi.inbound.reply` | inbound |
| `inbound.pollVote` | `ravi.inbound.pollVote` | inbound |
| `cli.session-command` | `ravi.*.cli.*.*` | cli |
| `cli.standalone-command` | `ravi._cli.cli.*.*` | cli |
| `approval.request` | `ravi.approval.request` | approval |
| `approval.response` | `ravi.approval.response` | approval |
| `audit.denied` | `ravi.audit.denied` | audit |
| `contacts.pending` | `ravi.contacts.pending` | approval |
| `chats.pending` | `ravi.chats.pending` | approval |
| `instances.unregistered` | `ravi.instances.unregistered` | audit |
| `inbox.mail.received` | `ravi.inbox.mail.received` | inbox |
| `console.inbox.item` | `ravi.console.inbox.item` | watch |
| `watch.event` | `ravi.watch.*.*` | watch |
| `task.event` | `ravi.task.*.event` | tasks |
| `tags.rule.applied` | `ravi.tags.rule.applied` | custom |

### Actual Publishers (non-catalog, non-session-runtime)

These subjects are emitted by publishers but are NOT in the trigger catalog:

| Subject | Publisher | Purpose |
|---|---|---|
| `ravi.config.changed` | agents, contacts, group, instances, settings, tui | Config reload signal |
| `ravi.triggers.refresh` | triggers CLI | Hot-reload trigger subscriptions |
| `ravi.triggers.test` | triggers CLI | Test trigger fire |
| `ravi.cron.refresh` | cron CLI | Refresh cron timers |
| `ravi.cron.trigger` | cron CLI | Manual cron trigger |
| `ravi.heartbeat.refresh` | heartbeat CLI | Refresh heartbeat timers |
| `ravi.outbound.deliver` | whatsapp-dm | Direct message delivery |
| `ravi.outbound.receipt` | whatsapp-dm | Delivery receipt |
| `ravi.outbound.reaction` | react CLI | Outbound emoji reaction |
| `ravi.stickers.send` | stickers CLI | Sticker send |
| `ravi.media.send` | media CLI | Media send |
| `ravi.session.abort` | agents, sessions, ephemeral | Session abort |
| `ravi.session.{op}.{phase}` | sessions CLI | Reset/delete/prune audit |
| `ravi.session.model.changed` | sessions CLI | Model switch |
| `ravi.contacts.events.*` | contacts.ts | Contact timeline events |
| `ravi.contacts.{id}.events.*` | contacts.ts | Per-contact timeline events |
| `ravi.tags.rule.applied` | tag-rules engine | Tag rule application |
| `ravi.contacts.{id}.tags.rule.applied` | tag-rules engine | Per-contact tag rule |
| `ravi.chats.{id}.tags.rule.applied` | tag-rules engine | Per-chat tag rule |
| `ravi.whatsapp.qr.*` | consumer | QR code relay |
| `ravi.whatsapp.connected.*` | consumer | Instance connected relay |
| `ravi.contacts.pending` | consumer | Pending contact |
| `ravi.chats.pending` | consumer | Pending chat |
| `ravi.task.{id}.event` | tasks service | Task lifecycle |
| `ravi.hooks.refresh` | hooks runtime | Hook refresh |
| `ravi.audit.denied` | permissions, bash hook | Permission denied |

## Gap Analysis By Domain

### 1. Sessions — Attach / Detach / Rename

**Current state:** Session reset/delete/prune emit `ravi.session.{op}.{phase}` audit events. Session abort emits `ravi.session.abort`. Model changes emit `ravi.session.model.changed`.

**Gaps:**
- **No `session.attached` event** when a chat is wired to a session via `sessions attach`.
- **No `session.detached` event** when a subscription is removed.
- **No `session.renamed` event** when a session's canonical name changes.
- **No `session.created` event** — covered by #165, not a duplicate recommendation.

The `sessions/attach` spec references tool trace events (`session.attach`, `session.detach`) but no canonical NATS subject exists for these.

### 2. Routes — Create / Update / Delete / Match

**Current state:** Route mutations emit only `ravi.config.changed` (a generic reload signal with no payload).

**Gaps:**
- **No `route.created` event** with route pattern, agent, account, priority.
- **No `route.updated` event** when route properties change.
- **No `route.deleted` event** when a route is removed.
- **No `route.matched` event** when a message is resolved to an agent via a route (high-volume, may need sampling or opt-in).

### 3. Permissions — Grant / Revoke / Profile Changes

**Current state:** Permission denials emit `ravi.audit.denied`. No events for grants or revocations.

**Gaps:**
- **No `permission.granted` event** when a relation is added.
- **No `permission.revoked` event** when a relation is removed.
- **No `permission.profile.applied` event** when a template is applied via `permissions init`.
- **No `permission.sync` event** when permissions are re-synced from config.

### 4. Triggers — Create / Update / Enable / Disable / Fire / Fail

**Current state:** All trigger mutations emit `ravi.triggers.refresh` (a generic reload signal). Test fires emit `ravi.triggers.test`.

**Gaps:**
- **No `trigger.created` event** with trigger id, topic, agent, cooldown.
- **No `trigger.updated` event** when properties change.
- **No `trigger.enabled` / `trigger.disabled` event**.
- **No `trigger.fired` event** when the trigger runner dispatches a prompt.
- **No `trigger.failed` event** when trigger dispatch fails.
- **No `trigger.deleted` event**.

The `ravi.triggers.refresh` signal carries no payload beyond `{}` and is not suitable for automation/observability.

### 5. Cron / Heartbeat — Run Lifecycle

**Current state:** Cron mutations emit `ravi.cron.refresh`. Manual runs emit `ravi.cron.trigger`. Heartbeat mutations emit `ravi.heartbeat.refresh`.

**Gaps:**
- **No `cron.job.created` / `cron.job.updated` / `cron.job.deleted` event**.
- **No `cron.job.enabled` / `cron.job.disabled` event**.
- **No `cron.run.started` / `cron.run.completed` / `cron.run.failed` event** for individual job executions.
- **No `heartbeat.run.started` / `heartbeat.run.completed` / `heartbeat.run.skipped` event**.
- **No `heartbeat.config.changed` event** (enable/disable/interval change).

### 6. Instances — Register / Update / Delete

**Current state:** Instance mutations emit `ravi.config.changed`. The consumer emits `ravi.instances.unregistered` for unknown instances. WhatsApp QR/connected events are relayed as `ravi.whatsapp.qr.*` / `ravi.whatsapp.connected.*`.

**Gaps:**
- **No `instance.registered` event** when a new instance is added to Ravi.
- **No `instance.updated` event** when instance config changes (agent mapping, routes, policies).
- **No `instance.deleted` event** when an instance is removed.

### 7. Agents — Create / Update / Delete

**Current state:** Agent mutations emit `ravi.config.changed`.

**Gaps:**
- **No `agent.created` event** — covered by #165, not a duplicate recommendation.
- **No `agent.updated` event** when agent config changes (model, mode, dmScope, debounce, cwd).
- **No `agent.deleted` event** when an agent is removed.

### 8. Observer Bindings — Lifecycle

**Current state:** The `runtime/observation-plane` spec describes observer bindings but no canonical events exist for binding lifecycle.

**Gaps:**
- **No `observer.binding.created` event**.
- **No `observer.binding.removed` event**.
- **No `observer.delivery.dispatched` event**.

### 9. Contacts — Lifecycle Beyond Timeline

**Current state:** Contact timeline events are well-covered via `ravi.contacts.events.*`. Pending contacts emit `ravi.contacts.pending`. Tag rules emit `ravi.tags.rule.applied`.

**Gaps:**
- **No `contact.status.changed` event** when a contact moves between `allowed`, `pending`, `blocked`, `discovered` (separate from timeline — this is a policy state change).
- **No `contact.merged` event** for identity graph merge operations.

### 10. Artifacts — Lifecycle

**Current state:** Artifacts have a rich event timeline internally but no NATS events.

**Gaps:**
- **No `artifact.created` event** when an artifact is registered.
- **No `artifact.status.changed` event** when status transitions (`pending` -> `running` -> `completed`/`failed`).

### 11. Tasks — Beyond `task.*.event`

**Current state:** Task lifecycle is well-covered by `ravi.task.{id}.event` in both the trigger catalog and actual publishers.

**Gaps (minor):**
- **No aggregate `task.status.changed` event** (the per-task subject `ravi.task.{id}.event` requires knowing the task id to subscribe). A global task status feed would help dashboards.

### 12. Apps — Lifecycle

**Current state:** No NATS events for app lifecycle.

**Gaps:**
- **No `app.installed` / `app.uninstalled` event**.
- **No `app.enabled` / `app.disabled` event**.

## Prioritized Candidate Matrix

### Scoring

- **Value**: How much operational/automation benefit the event provides. Scale: 1 (low) to 5 (critical).
- **Risk**: Privacy/security risk of the payload. Scale: 1 (safe) to 5 (sensitive).
- **Effort**: Implementation complexity. Scale: 1 (trivial) to 5 (complex).

### Matrix

| # | Subject | Owner | Classification | Replay | Trigger Catalog | Value | Risk | Effort | Priority |
|---|---|---|---|---|---|---|---|---|---|
| 1 | `ravi.trigger.lifecycle` | routines | `public-trigger` | yes | yes | 5 | 1 | 2 | **quick-win** |
| 2 | `ravi.session.attach.changed` | sessions | `public-trigger` | yes | yes | 5 | 1 | 2 | **quick-win** |
| 3 | `ravi.permission.changed` | permissions | `replay-only` | yes | no | 4 | 3 | 2 | **quick-win** |
| 4 | `ravi.cron.run.lifecycle` | cron | `public-trigger` | yes | yes | 4 | 1 | 2 | **quick-win** |
| 5 | `ravi.instance.lifecycle` | channels | `replay-only` | yes | no | 4 | 2 | 2 | **quick-win** |
| 6 | `ravi.heartbeat.run.lifecycle` | heartbeat | `public-trigger` | yes | yes | 3 | 1 | 2 | **medium** |
| 7 | `ravi.route.changed` | routing | `replay-only` | yes | no | 3 | 2 | 2 | **medium** |
| 8 | `ravi.agent.updated` | agents | `replay-only` | yes | no | 3 | 2 | 2 | **medium** |
| 9 | `ravi.contact.status.changed` | contacts | `replay-only` | yes | no | 3 | 3 | 2 | **medium** |
| 10 | `ravi.artifact.lifecycle` | artifacts | `public-trigger` | yes | yes | 3 | 1 | 3 | **medium** |
| 11 | `ravi.observer.binding.lifecycle` | runtime | `internal-control` | yes | no | 2 | 1 | 3 | **medium** |
| 12 | `ravi.session.renamed` | sessions | `replay-only` | yes | no | 2 | 1 | 1 | **quick-win** |
| 13 | `ravi.task.status.global` | tasks | `public-trigger` | yes | yes | 3 | 1 | 2 | **medium** |
| 14 | `ravi.app.lifecycle` | apps | `internal-control` | yes | no | 2 | 1 | 3 | **deferred** |
| 15 | `ravi.contact.merged` | contacts | `replay-only` | yes | no | 2 | 3 | 3 | **deferred** |
| 16 | `ravi.route.matched` | routing | `internal-control` | no | no | 2 | 2 | 4 | **deferred** |

### Candidate Details

---

#### 1. `ravi.trigger.lifecycle`

**Proposed subjects:**
- `ravi.trigger.created`
- `ravi.trigger.updated`
- `ravi.trigger.enabled`
- `ravi.trigger.disabled`
- `ravi.trigger.fired`
- `ravi.trigger.failed`
- `ravi.trigger.deleted`

**Owner:** routines
**Classification:** `public-trigger`
**Replay:** yes — trigger lifecycle is important for debugging routine behavior.
**Trigger catalog:** yes — routines can observe other routines' lifecycle.
**Privacy risk:** Low. Payload contains trigger id, topic pattern, agent id, timestamp. No user data.

**Payload sketch:**

```ts
{
  triggerId: string;
  name: string;
  event: "created" | "updated" | "enabled" | "disabled" | "fired" | "failed" | "deleted";
  agentId: string;
  topic?: string;       // the subscribed topic pattern
  sessionType?: string; // "main" | "isolated"
  error?: string;       // for "failed" only, safe error message
  timestamp: string;
}
```

**Consumers:** trigger dashboards, routine composition, operational alerting.
**Affected specs:** `routines/triggers`.

---

#### 2. `ravi.session.attach.changed`

**Proposed subjects:**
- `ravi.session.attach.created` — chat attached to session
- `ravi.session.attach.removed` — chat detached

**Owner:** sessions
**Classification:** `public-trigger`
**Replay:** yes — attach mutations affect routing and output behavior.
**Trigger catalog:** yes — routines can react to session wiring changes.
**Privacy risk:** Low. Payload contains session key and chat id. No message content.

**Payload sketch:**

```ts
{
  sessionKey: string;
  chatId: string;
  event: "attached" | "detached";
  isOutputTarget?: boolean;
  actor: string;     // "cli" | "agent" | "system"
  reason?: string;
  timestamp: string;
}
```

**Consumers:** routing auditors, session management dashboards, cross-session coordination.
**Affected specs:** `sessions`, `sessions/attach`.

---

#### 3. `ravi.permission.changed`

**Proposed subjects:**
- `ravi.permission.granted`
- `ravi.permission.revoked`
- `ravi.permission.profile.applied`
- `ravi.permission.synced`

**Owner:** permissions
**Classification:** `replay-only` — permission changes are security-sensitive and MUST NOT be exposed as public triggers until reviewed.
**Replay:** yes — essential for security auditing.
**Trigger catalog:** no — requires human review before exposing to routines.
**Privacy risk:** Medium. Payload contains subject/object/relation triples. No credentials, but reveals the permission topology.

**Payload sketch:**

```ts
{
  event: "granted" | "revoked" | "profile_applied" | "synced";
  subject: string;   // e.g. "agent:dev"
  relation?: string; // e.g. "use", "execute", "access"
  object?: string;   // e.g. "tool:Bash", "group:contacts"
  profile?: string;  // for "profile_applied"
  actor: string;
  timestamp: string;
}
```

**Consumers:** security audit log, permission change notifications.
**Affected specs:** `permissions`.

---

#### 4. `ravi.cron.run.lifecycle`

**Proposed subjects:**
- `ravi.cron.job.created`
- `ravi.cron.job.updated`
- `ravi.cron.job.enabled`
- `ravi.cron.job.disabled`
- `ravi.cron.job.deleted`
- `ravi.cron.run.started`
- `ravi.cron.run.completed`
- `ravi.cron.run.failed`

**Owner:** cron
**Classification:** `public-trigger`
**Replay:** yes — cron execution history is critical for scheduling observability.
**Trigger catalog:** yes — routines can chain off cron job lifecycle.
**Privacy risk:** Low. Payload contains job id, name, schedule, agent. No message content or prompts.

**Payload sketch:**

```ts
{
  jobId: string;
  name: string;
  event: "created" | "updated" | "enabled" | "disabled" | "deleted" | "run.started" | "run.completed" | "run.failed";
  agentId?: string;
  schedule?: string;    // cron expression or interval, for config events
  error?: string;       // for "run.failed"
  durationMs?: number;  // for "run.completed"
  timestamp: string;
}
```

**Consumers:** cron dashboards, scheduling observability, operational alerting.
**Affected specs:** `cron` (if present).

---

#### 5. `ravi.instance.lifecycle`

**Proposed subjects:**
- `ravi.instance.registered`
- `ravi.instance.updated`
- `ravi.instance.deleted`

**Owner:** channels
**Classification:** `replay-only` — instance changes affect security boundaries and should be reviewed before trigger exposure.
**Replay:** yes.
**Trigger catalog:** no — requires review.
**Privacy risk:** Low-Medium. Payload contains instance id, channel type, account id. No credentials.

**Payload sketch:**

```ts
{
  instanceId: string;
  channelType: string;
  event: "registered" | "updated" | "deleted";
  accountId?: string;
  agentId?: string;
  actor: string;
  timestamp: string;
}
```

**Consumers:** instance management dashboards, channel health monitors.
**Affected specs:** `channels`.

---

#### 6. `ravi.heartbeat.run.lifecycle`

**Proposed subjects:**
- `ravi.heartbeat.run.started`
- `ravi.heartbeat.run.completed`
- `ravi.heartbeat.run.skipped`
- `ravi.heartbeat.config.changed`

**Owner:** heartbeat
**Classification:** `public-trigger`
**Replay:** yes.
**Trigger catalog:** yes — routines can observe heartbeat health.
**Privacy risk:** Low. Payload contains agent id, interval, timestamp. No HEARTBEAT.md content.

**Payload sketch:**

```ts
{
  agentId: string;
  event: "run.started" | "run.completed" | "run.skipped" | "config.changed";
  interval?: string;
  skippedReason?: string; // e.g. "outside_active_hours", "suppressed"
  durationMs?: number;
  timestamp: string;
}
```

**Consumers:** heartbeat health dashboards, operational alerting.
**Affected specs:** related to `routines`.

---

#### 7. `ravi.route.changed`

**Proposed subjects:**
- `ravi.route.created`
- `ravi.route.updated`
- `ravi.route.deleted`

**Owner:** routing
**Classification:** `replay-only` — route changes affect message routing and need audit but are not immediately safe for trigger automation.
**Replay:** yes.
**Trigger catalog:** no — requires review.
**Privacy risk:** Low-Medium. Contains route patterns (which may include phone numbers). Pattern should be redacted or hashed.

**Payload sketch:**

```ts
{
  routeId: string;
  event: "created" | "updated" | "deleted";
  pattern?: string;     // safe pattern, e.g. "+55*"
  agentId?: string;
  accountId?: string;
  priority?: number;
  actor: string;
  timestamp: string;
}
```

**Consumers:** routing audit, config change tracking.
**Affected specs:** `sessions`, `channels`.

---

#### 8. `ravi.agent.updated`

**Proposed subject:** `ravi.agent.updated`

**Owner:** agents
**Classification:** `replay-only`
**Replay:** yes.
**Trigger catalog:** no — agent config changes are operational, not routine-triggerable by default.
**Privacy risk:** Low-Medium. Contains agent id, changed properties (model, mode, dmScope). No credentials.

**Payload sketch:**

```ts
{
  agentId: string;
  event: "updated";
  changedFields: string[]; // e.g. ["model", "dmScope"]
  actor: string;
  timestamp: string;
}
```

**Consumers:** agent config audit, operational dashboards.
**Affected specs:** `agents` (when created).

Note: `agent.created` and `agent.deleted` are covered by #165.

---

#### 9. `ravi.contact.status.changed`

**Proposed subject:** `ravi.contact.status.changed`

**Owner:** contacts
**Classification:** `replay-only` — status changes are policy decisions that should be audit-logged but not automatically trigger-exposed.
**Replay:** yes.
**Trigger catalog:** no — requires privacy review.
**Privacy risk:** Medium. Contains contact id and status transition. Contact id is opaque but reveals contact existence.

**Payload sketch:**

```ts
{
  contactId: string;
  event: "status.changed";
  fromStatus: string; // "pending" | "allowed" | "blocked" | "discovered"
  toStatus: string;
  actor: string;
  timestamp: string;
}
```

**Consumers:** contact lifecycle audit, CRM integrations.
**Affected specs:** `contacts`.

---

#### 10. `ravi.artifact.lifecycle`

**Proposed subjects:**
- `ravi.artifact.created`
- `ravi.artifact.status.changed`

**Owner:** artifacts
**Classification:** `public-trigger`
**Replay:** yes.
**Trigger catalog:** yes — routines can react when artifacts complete or fail.
**Privacy risk:** Low. Contains artifact id, kind, status. No file content or paths.

**Payload sketch:**

```ts
{
  artifactId: string;
  event: "created" | "status.changed";
  kind?: string;
  status?: string;        // "pending" | "running" | "completed" | "failed"
  previousStatus?: string;
  sessionName?: string;
  timestamp: string;
}
```

**Consumers:** artifact dashboards, generation completion handlers.
**Affected specs:** `artifacts`.

---

#### 11. `ravi.observer.binding.lifecycle`

**Proposed subjects:**
- `ravi.observer.binding.created`
- `ravi.observer.binding.removed`

**Owner:** runtime
**Classification:** `internal-control` — observer bindings are runtime internals.
**Replay:** yes.
**Trigger catalog:** no.
**Privacy risk:** Low. Contains binding id, source session, observer session. No content.

**Payload sketch:**

```ts
{
  bindingId: string;
  event: "created" | "removed";
  sourceSession: string;
  observerSession: string;
  observerMode?: string;
  timestamp: string;
}
```

**Consumers:** observation plane debugging, runtime diagnostics.
**Affected specs:** `runtime/observation-plane`.

---

#### 12. `ravi.session.renamed`

**Proposed subject:** `ravi.session.renamed`

**Owner:** sessions
**Classification:** `replay-only`
**Replay:** yes — rename changes the human-facing name while session_key stays stable; important for trace continuity.
**Trigger catalog:** no.
**Privacy risk:** Low. Contains session key, old name, new name.

**Payload sketch:**

```ts
{
  sessionKey: string;
  oldName: string;
  newName: string;
  actor: string;
  timestamp: string;
}
```

**Consumers:** session audit trail, routing diagnostics.
**Affected specs:** `sessions`.

---

#### 13. `ravi.task.status.global`

**Proposed subject:** `ravi.task.status.changed`

**Owner:** tasks
**Classification:** `public-trigger`
**Replay:** yes.
**Trigger catalog:** yes — the existing `ravi.task.*.event` requires knowing task id; a global feed enables dashboard-style subscriptions.
**Privacy risk:** Low. Contains task id, status, agent. No task instructions or content.

**Payload sketch:**

```ts
{
  taskId: string;
  event: "status.changed";
  status: string;       // "pending" | "active" | "completed" | "failed" | "blocked"
  previousStatus?: string;
  agentId?: string;
  timestamp: string;
}
```

**Consumers:** task dashboards, operational alerting, cross-task coordination.
**Affected specs:** `tasks`.

---

#### 14. `ravi.app.lifecycle`

**Proposed subjects:**
- `ravi.app.installed`
- `ravi.app.uninstalled`
- `ravi.app.enabled`
- `ravi.app.disabled`

**Owner:** apps
**Classification:** `internal-control` — apps are an emerging domain; events should be internal until the model stabilizes.
**Replay:** yes.
**Trigger catalog:** no.
**Privacy risk:** Low.

**Payload sketch:**

```ts
{
  appId: string;
  event: "installed" | "uninstalled" | "enabled" | "disabled";
  version?: string;
  actor: string;
  timestamp: string;
}
```

**Consumers:** app management dashboards.
**Affected specs:** `apps`.

---

#### 15. `ravi.contact.merged`

**Proposed subject:** `ravi.contact.merged`

**Owner:** contacts
**Classification:** `replay-only`
**Replay:** yes.
**Trigger catalog:** no — identity graph merges are sensitive.
**Privacy risk:** Medium-High. Reveals identity relationships.

**Payload sketch:**

```ts
{
  event: "merged";
  survivorId: string;
  mergedIds: string[];
  actor: string;
  timestamp: string;
}
```

**Consumers:** identity graph audit, CRM sync.
**Affected specs:** `contacts`.

---

#### 16. `ravi.route.matched`

**Proposed subject:** `ravi.route.matched`

**Owner:** routing
**Classification:** `internal-control`
**Replay:** no — high-volume event, not suitable for durable replay by default.
**Trigger catalog:** no.
**Privacy risk:** Medium. Contains sender info and route resolution.

**Payload sketch:**

```ts
{
  event: "matched";
  routeId?: string;
  agentId: string;
  sessionKey: string;
  source: string;     // "route" | "account-agent" | "default"
  timestamp: string;
}
```

**Consumers:** routing diagnostics, debugging.
**Affected specs:** `sessions`, `channels`.

## Recommended Follow-Up Candidates

The following 7 candidates are recommended for follow-up implementation after human review:

1. **Trigger lifecycle events** (#1) — quick-win, high value, safe payload, directly improves routine observability.
2. **Session attach/detach events** (#2) — quick-win, high value, required by `sessions/attach` spec.
3. **Cron run lifecycle events** (#4) — quick-win, high value, safe payload, directly improves scheduling observability.
4. **Permission changed events** (#3) — quick-win, high value, but requires privacy review before trigger catalog exposure.
5. **Instance lifecycle events** (#5) — quick-win, moderate value, strengthens channel management observability.
6. **Heartbeat run lifecycle events** (#6) — medium effort, moderate value, improves proactive scheduling observability.
7. **Session renamed event** (#12) — trivial effort, moderate value, completes session lifecycle coverage.

### Implementation Order Recommendation

**Phase 1 — Quick Wins (low effort, safe payloads):**
- #1 Trigger lifecycle
- #2 Session attach changes
- #4 Cron run lifecycle
- #12 Session renamed

**Phase 2 — Medium (requires privacy/security review):**
- #3 Permission changes (replay-only until reviewed)
- #5 Instance lifecycle (replay-only until reviewed)
- #6 Heartbeat run lifecycle

**Phase 3 — Deferred (requires product decisions):**
- #7 Route changes
- #8 Agent updated
- #9 Contact status changes
- #10 Artifact lifecycle
- #11 Observer binding lifecycle
- #13 Global task status
- #14 App lifecycle
- #15 Contact merged
- #16 Route matched

## Invariants

- Implementation candidates are **recommendations only**. They MUST NOT become ready implementation tasks without human review.
- Proposed payloads MUST NOT include secrets, credentials, raw prompts, raw context blobs, context keys, private local paths, or user/customer data.
- Events classified as `replay-only` or `internal-control` MUST NOT appear in the trigger topic catalog until reviewed by a human for privacy/security.
- `agent.created` and `session.created` are related work covered by #165 and are NOT duplicate recommendations for this analysis.
- Each follow-up implementation task SHOULD be scoped to a single domain and SHOULD include: publisher implementation, audit stream subject addition (if not already covered by wildcards), trigger catalog entry (for `public-trigger` classification), and test coverage.

## Validation

- `ravi specs sync --json`
- `ravi specs get events/gap-analysis --mode full --json`
- `ravi specs get events/gap-analysis --mode checks --json`
- `bun test src/events/audit-stream.test.ts`
