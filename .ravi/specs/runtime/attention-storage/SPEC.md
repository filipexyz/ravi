---
id: runtime/attention-storage
title: "Attention occurrence identity and storage"
kind: capability
domain: runtime
capabilities:
  - attention-storage
tags:
  - attention
  - storage
applies_to:
  - src/orchestration/identity.ts
  - src/orchestration/schema.ts
  - src/orchestration/occurrence-store.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Attention occurrence storage

## Intent

Persist two kinds of task-scoped occurrence independently of worker status, delivery, or an active orchestration mode. A completed task can have a result without a dependency or decision. Replaying a requirement must retain its identity through retries and executor replacement.

## Contract

- `OccurrenceIdentityV1` MUST be the discriminated union of `RequirementOccurrence` and `TaskResultOccurrence`, both with `schemaVersion: 1`, `chatId: string`, and `taskId: string`.
- A requirement MUST additionally carry `commitmentKey: string`, `requirementKind: "dependency_complete" | "decision_answered"`, and `subjectId: string`.
- A task result MUST additionally carry `outcomeKind: "completed" | "failed"` and `outcomeVersion: number`, a safe integer at least one. It MUST NOT require or accept requirement or commitment fields.
- Validation MUST reject empty IDs, unsupported schema/kind values, foreign fields, and invalid versions before writing. In particular, `thread_decision` MUST be rejected, not converted into a task occurrence.
- Identity MUST hash the UTF-8 JSON serialization of the ordered tuple with SHA-256: `["attention.occurrence.v1", "requirement", chatId, commitmentKey, taskId, requirementKind, subjectId]` or `["attention.occurrence.v1", "task_result", chatId, taskId, outcomeKind, outcomeVersion]`. IDs MUST remain exact; no text normalization, task status, executor, timestamp, retry count, or prose participates.
- `chat_attention_occurrences.kind` and its variant CHECK MUST enforce those two shapes for direct SQL writes too. `task_id` MUST be non-null. `thread_id` and `decision_ref` are absent.
- `uq_attention_requirement` MUST uniquely index `(kind,chat_id,commitment_key,task_id,requirement_kind,subject_id)` with `WHERE kind='requirement'`.
- `uq_attention_task_result` MUST uniquely index `(kind,chat_id,task_id,outcome_kind,outcome_version)` with `WHERE kind='task_result'`.
- `migrateAttentionOccurrences(db)` MUST execute the table and index creation in one immediate transaction. Repeating it MUST preserve existing rows. No legacy attention schema has shipped; this migration creates the initial schema without historical backfill.
- `getOrCreateOccurrence(db, identity)` MUST validate and calculate the canonical key, then use the matching partial index as its conflict target in one immediate transaction. Replay MUST return the existing key without resetting fact state, revisions, resolution proof, or row version. A returned key different from the canonical key MUST fail and roll back; a primary-key collision on another tuple MUST also fail.
- Schema and store MUST receive an explicit database. Importing these modules MUST NOT open state, register a runtime migration, emit events, create receipts, or send messages. New writable SQLite constructors in tests MUST use `openStateDatabase` and temporary paths.

## Deliberate boundary

This PR provides identity/storage only. Canonical result-version production, source classification, material revisions, audience admission, bindings, CAS/handoff, delivery receipts, and activation remain later work. Storing an identity does not prove a result, authorize attention, or enable a mode.

`thread_decision` is deferred to a later PR dependent on item 1's context/audience contract. That PR must add a complete task-free variant, a variant CHECK, its own partial unique index, and `thread_decision_without_task_is_idempotent_and_disjoint` without fabricating a task. Context proof remains an activation gate, not a dependency of this isolated storage contract.

The accepted D4 adapter capability contract (`executeSlackUpdate` and its three tests) is unchanged and is not implemented by this storage PR.
