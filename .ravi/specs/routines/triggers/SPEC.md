---
id: routines/triggers
title: "Trigger Topics And Filters"
kind: capability
domain: routines
capability: triggers
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/triggers
  - src/cli/commands/triggers.ts
  - src/plugins/internal/ravi-system/skills/triggers/SKILL.md
tags:
  - routines
  - triggers
  - nats
  - topics
  - filters
---

# Trigger Topics And Filters

## Intent

Trigger topics are the event subjects a routine can observe. The trigger topic catalog is the durable bank of examples, schemas, default message templates, notes, and patterns that humans and agents should consult before creating a trigger.

Trigger filters are the deterministic pre-agent predicate for event payloads. They prevent avoidable agent runs and MUST be safe to evaluate without `eval` or arbitrary code execution.

## Invariants

- Trigger-ready Ravi-maintained subjects SHOULD be registered in `src/triggers/topic-catalog.ts`.
- Trigger examples in docs, skills, and CLI help MUST use cataloged subjects unless they are explicitly marked as custom publisher subjects.
- Channel transport aliases such as `whatsapp.*.reaction`, `whatsapp.*.inbound`, and `matrix.*.inbound` MUST NOT be documented as trigger-ready subjects unless a Ravi publisher actually emits them.
- Emoji reaction triggers MUST use `ravi.inbound.reaction` until a different subject is deliberately added to the catalog and publisher.
- Reaction trigger payloads MUST be documented as correlation events, not full chat/message records. The current `ravi.inbound.reaction` payload identifies `{ targetMessageId, emoji, senderId }`; it does not guarantee `chatId`, message caption, media metadata, or domain state.
- Routines that need to publish or approve domain objects from a reaction MUST persist a durable mapping keyed by the outbound message external id before waiting for the reaction. The trigger handler MUST resolve `targetMessageId` against that state and stay silent when there is no match.
- The CLI MUST NOT block custom NATS subjects. It SHOULD warn when a subject is outside the built-in catalog or looks like a known inferred alias without a Ravi publisher.
- The catalog MUST expose a machine-readable payload schema for Ravi-maintained trigger-ready subjects.
- Catalog schemas MUST describe safe agent-facing payload fields with `path`, `type`, `required`, and `description`.
- Catalog schemas MUST NOT require agents to infer fields from prose-only payload strings.
- The catalog SHOULD include a default message template when a subject has an obvious safe agent-facing notification.
- Catalog default message templates MUST use the trigger template syntax accepted by the runtime, currently `{{topic}}` and `{{data.<path>}}`.
- `ravi triggers add` MAY omit `--message` only when the selected topic matches a catalog entry with a default message template.
- `ravi triggers add` MUST persist catalog-template provenance for catalog defaults so runtime formatting does not depend only on comparing message strings.
- `ravi triggers add` MUST still reject missing `--message` for custom subjects or catalog entries without a default template.
- Default message templates MUST be concise, action-oriented, and point agents at a local Ravi CLI command when the event references a durable local object.
- Trigger prompts built from catalog default message templates MUST use a standardized header and MUST NOT include the raw `Data: <json>` block.
- The standardized catalog-template prompt header MUST identify both that the prompt came from a trigger and which event fired it:
  - `[Trigger: <trigger name>]`
  - `Event: <event topic>`
- Manual/custom trigger prompts MAY continue to include raw event data for debugging and legacy automations.
- Native local inbox events MUST be distinct from Console delivery mirror events. Email automations SHOULD listen to `ravi.inbox.mail.received`; `ravi.console.inbox.item` is a technical mirror and MUST NOT be documented as the durable local email subject.
- The catalog SHOULD include payload schema, default message template when available, example command, common filters, and operational notes for each subject.
- Trigger filters MUST support the comparison operators `==`, `!=`, `startsWith`, `endsWith`, and `includes`.
- Trigger filters MUST support boolean composition with `&&`, `||`, unary `!`, and parentheses.
- Trigger filter precedence MUST be `!` before `&&` before `||`.
- Trigger filter values MUST be quoted strings; event values are coerced to strings for comparison.
- Trigger filter evaluation MUST NOT use JavaScript `eval`, `new Function`, or shell execution.
- The CLI MUST reject invalid filter syntax before persisting a new or updated trigger filter.
- Runtime evaluation MAY fail open for legacy persisted invalid filters, but it MUST log a warning with the parse error.

## Acceptance Criteria

- `ravi triggers topics --json` exposes the catalog in machine-readable form.
- `ravi triggers topics --json` includes `schema.fields[]` for built-in trigger-ready subjects.
- `ravi triggers topics --json` includes `messageTemplate` for topics with a safe built-in default message.
- `ravi triggers add "New local email" --topic "ravi.inbox.mail.received"` persists the catalog default message template without requiring `--message`.
- A trigger created from a catalog default stores message provenance as catalog/template metadata.
- The default `ravi.inbox.mail.received` message tells the agent a new email arrived, includes the local message id, exact display text for `De`/`Para`, and points at `ravi mail messages read <id>`.
- If the local email event includes attachment metadata, trigger prompts MAY summarize filenames/counts but MUST NOT inline attachment bytes; agents should read/download attachments through explicit mail commands.
- When the `ravi.inbox.mail.received` default template fires, the delivered prompt starts with `[Trigger: New local email]`, includes `Event: ravi.inbox.mail.received`, and does not include a raw JSON `Data:` block.
- `ravi triggers add "Custom" --topic "custom.external.>"` without `--message` fails clearly because custom subjects have no catalog template.
- `ravi triggers add --topic "whatsapp.*.reaction"` succeeds with a warning that `ravi.inbound.reaction` is the canonical built-in reaction subject.
- `ravi triggers add --topic "custom.external.>"` succeeds with a warning that the subject is custom/outside built-in templates.
- `ravi triggers add --filter 'data.chatId == "X" && (data.status == "approved" || data.status == "manual")'` persists the filter and evaluates correctly.
- Reaction approval examples filter on fields present in the reaction payload, such as `data.emoji` or `data.senderId`, and tell the agent to load domain state by `data.targetMessageId`.
- `ravi triggers set <id> filter 'data.ok == true'` fails clearly because values must be quoted.
- Skills and docs point users to the catalog instead of asking them to infer subjects by symmetry.
