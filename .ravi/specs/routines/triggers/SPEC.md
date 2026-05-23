---
id: routines/triggers
title: "Trigger Topics"
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
---

# Trigger Topics

## Intent

Trigger topics are the event subjects a routine can observe. The trigger topic catalog is the durable bank of examples, schemas, notes, and patterns that humans and agents should consult before creating a trigger.

## Invariants

- Trigger-ready Ravi-maintained subjects SHOULD be registered in `src/triggers/topic-catalog.ts`.
- Trigger examples in docs, skills, and CLI help MUST use cataloged subjects unless they are explicitly marked as custom publisher subjects.
- Channel transport aliases such as `whatsapp.*.reaction`, `whatsapp.*.inbound`, and `matrix.*.inbound` MUST NOT be documented as trigger-ready subjects unless a Ravi publisher actually emits them.
- Emoji reaction triggers MUST use `ravi.inbound.reaction` until a different subject is deliberately added to the catalog and publisher.
- The CLI SHOULD reject known inferred aliases that do not have publishers, while still allowing custom subjects such as `doma.rdp.>`.
- The catalog SHOULD include payload schema, example command, common filters, and operational notes for each subject.

## Acceptance Criteria

- `ravi triggers topics --json` exposes the catalog in machine-readable form.
- `ravi triggers add --topic "whatsapp.*.reaction"` fails with a hint to use `ravi.inbound.reaction`.
- Skills and docs point users to the catalog instead of asking them to infer subjects by symmetry.
