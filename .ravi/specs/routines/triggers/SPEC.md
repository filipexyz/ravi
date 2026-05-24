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

Trigger topics are the event subjects a routine can observe. The trigger topic catalog is the durable bank of examples, schemas, notes, and patterns that humans and agents should consult before creating a trigger.

Trigger filters are the deterministic pre-agent predicate for event payloads. They prevent avoidable agent runs and MUST be safe to evaluate without `eval` or arbitrary code execution.

## Invariants

- Trigger-ready Ravi-maintained subjects SHOULD be registered in `src/triggers/topic-catalog.ts`.
- Trigger examples in docs, skills, and CLI help MUST use cataloged subjects unless they are explicitly marked as custom publisher subjects.
- Channel transport aliases such as `whatsapp.*.reaction`, `whatsapp.*.inbound`, and `matrix.*.inbound` MUST NOT be documented as trigger-ready subjects unless a Ravi publisher actually emits them.
- Emoji reaction triggers MUST use `ravi.inbound.reaction` until a different subject is deliberately added to the catalog and publisher.
- Reaction trigger payloads MUST be documented as correlation events, not full chat/message records. The current `ravi.inbound.reaction` payload identifies `{ targetMessageId, emoji, senderId }`; it does not guarantee `chatId`, message caption, media metadata, or domain state.
- Routines that need to publish or approve domain objects from a reaction MUST persist a durable mapping keyed by the outbound message external id before waiting for the reaction. The trigger handler MUST resolve `targetMessageId` against that state and stay silent when there is no match.
- The CLI MUST NOT block custom NATS subjects. It SHOULD warn when a subject is outside the built-in catalog or looks like a known inferred alias without a Ravi publisher.
- The catalog SHOULD include payload schema, example command, common filters, and operational notes for each subject.
- Trigger filters MUST support the comparison operators `==`, `!=`, `startsWith`, `endsWith`, and `includes`.
- Trigger filters MUST support boolean composition with `&&`, `||`, unary `!`, and parentheses.
- Trigger filter precedence MUST be `!` before `&&` before `||`.
- Trigger filter values MUST be quoted strings; event values are coerced to strings for comparison.
- Trigger filter evaluation MUST NOT use JavaScript `eval`, `new Function`, or shell execution.
- The CLI MUST reject invalid filter syntax before persisting a new or updated trigger filter.
- Runtime evaluation MAY fail open for legacy persisted invalid filters, but it MUST log a warning with the parse error.

## Acceptance Criteria

- `ravi triggers topics --json` exposes the catalog in machine-readable form.
- `ravi triggers add --topic "whatsapp.*.reaction"` succeeds with a warning that `ravi.inbound.reaction` is the canonical built-in reaction subject.
- `ravi triggers add --topic "custom.external.>"` succeeds with a warning that the subject is custom/outside built-in templates.
- `ravi triggers add --filter 'data.chatId == "X" && (data.status == "approved" || data.status == "manual")'` persists the filter and evaluates correctly.
- Reaction approval examples filter on fields present in the reaction payload, such as `data.emoji` or `data.senderId`, and tell the agent to load domain state by `data.targetMessageId`.
- `ravi triggers set <id> filter 'data.ok == true'` fails clearly because values must be quoted.
- Skills and docs point users to the catalog instead of asking them to infer subjects by symmetry.
