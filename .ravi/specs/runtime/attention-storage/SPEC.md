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
  - src/orchestration/raw-attention-input.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Attention occurrence storage

## Intent

Persist requirements, task results and task-free thread decisions independently of worker status, delivery, or an active orchestration mode. A completed task can have a result without a dependency or decision. Replaying a requirement must retain its identity through retries and executor replacement.

## Contract

- `OccurrenceIdentityV1` MUST be the discriminated union of `RequirementOccurrence`, `TaskResultOccurrence` and `ThreadDecisionOccurrence`, each with `schemaVersion: 1` and `chatId: string`. Only requirement and task_result carry `taskId: string`.
- A requirement MUST additionally carry `commitmentKey: string`, `requirementKind: "dependency_complete" | "decision_answered"`, and `subjectId: string`.
- A task result MUST additionally carry `outcomeKind: "completed" | "failed"` and `outcomeVersion: number`, a safe integer at least one. It MUST NOT require or accept requirement or commitment fields.
- A thread decision MUST carry `threadId: string` and `decisionRef: string`, with no task, requirement, outcome or commitment fields. `threadId` MUST preserve the persisted `ThreadRecord.id` exactly, without trimming or normalization.
- `RawAttentionInput` MUST discriminate the same three variants; its thread_decision variant carries thread/decision facts and no task. These are input types only: this PR MUST NOT implement readers, classification, arbitration, audience/provenance or adapters.
- Validation MUST reject empty IDs, unsupported schema/kind values, foreign fields, and invalid versions before writing. A thread decision MUST NOT be converted into a task occurrence or receive a fabricated task.
- Identity MUST hash the UTF-8 JSON serialization of the ordered tuple with SHA-256: `["attention.occurrence.v1", "requirement", chatId, commitmentKey, taskId, requirementKind, subjectId]` `["attention.occurrence.v1", "task_result", chatId, taskId, outcomeKind, outcomeVersion]`, or `["attention.occurrence.v1", "thread_decision", chatId, threadId, decisionRef]`. IDs MUST remain exact; no text normalization, task status, executor, timestamp, retry count, or prose participates.
- `chat_attention_occurrences.kind` and its variant CHECK MUST enforce all three shapes for direct SQL writes too. `task_id` MUST be non-null for requirement/task_result and NULL for thread_decision. `thread_id` and `decision_ref` MUST be non-null only for thread_decision; all fields belonging to other variants MUST be NULL.
- `uq_attention_requirement` MUST uniquely index `(kind,chat_id,commitment_key,task_id,requirement_kind,subject_id)` with `WHERE kind='requirement'`.
- `uq_attention_task_result` MUST uniquely index `(kind,chat_id,task_id,outcome_kind,outcome_version)` with `WHERE kind='task_result'`.
- `uq_attention_thread_decision` MUST uniquely index `(kind,chat_id,thread_id,decision_ref)` with `WHERE kind='thread_decision'`.
- `migrateAttentionOccurrences(db)` MUST execute the table and index creation in one immediate transaction. Repeating it MUST preserve existing rows. No legacy attention schema has shipped; this migration creates the initial schema without historical backfill.
- `getOrCreateOccurrence(db, identity)` MUST validate and calculate the canonical key, then use the matching partial index as its conflict target in one immediate transaction. Replay MUST return the existing key without resetting fact state, revisions, resolution proof, or row version. A returned key different from the canonical key MUST fail and roll back; a primary-key collision on another tuple MUST also fail.
- Schema and store MUST receive an explicit database. Importing these modules MUST NOT open state, register a runtime migration, emit events, create receipts, or send messages. New writable SQLite constructors in tests MUST use `openStateDatabase` and temporary paths.

## Deliberate boundary

This PR provides identity/storage only. Canonical result-version production, source classification, material revisions, audience admission, bindings, CAS/handoff, delivery receipts, and activation remain later work. Storing an identity does not prove a result, authorize attention, or enable a mode.

Known limitations: `outcomeVersion` has no canonical producer until PR2 of item 3. This storage validates the caller's literal value without depending on that producer; no producer fills the column in production yet. Tests use literal versions. Any future change in the source/normalization of `ThreadRecord.id` requires a migration owned by PR2 of item 1, including affected references and occurrence keys.

Activation remains blocked until the contracts of items 1/2 and the product tests are fulfilled. The isolated tables and type declarations do not enable publication or prove source/audience authorization. Item 1 owns its fenced transactional writers. This module touches none of those stores, neither calls nor changes `withThreadWriteLease`, and writes only its own attention occurrence table on an injected database.

The accepted D4 adapter capability contract (`executeSlackUpdate` and its three tests) is unchanged and is not implemented by this storage PR.
