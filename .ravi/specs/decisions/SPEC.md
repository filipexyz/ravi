---
id: decisions
title: "Decisions"
kind: domain
domain: decisions
capabilities:
  - lifecycle
  - origins
  - delivery
tags:
  - decisions
  - tasks
  - threads
applies_to:
  - src/decisions/
  - src/cli/commands/decisions.ts
  - src/router/router-db.ts
  - src/runtime/prompt-subscription.ts
owners:
  - dev
status: draft
normative: true
---

# Decisions

## Intent

A decision owns a question, owner, immutable answer and audit history. Tasks and managed channel threads consume it. It MUST NOT create a task merely to store a thread's question or introduce a workflow engine.

## Identity and authority

- Every decision MUST have exactly one origin: `task` with a task id, or `thread` with a managed thread lifecycle id. A thread MUST additionally pin its canonical chat id and waiting session key; neither a display name nor a raw Slack timestamp is its semantic identity.
- Read and mutation authorization MUST be inherited from the origin. Unknown and inaccessible origins MUST be indistinguishable. A decisions command grant alone MUST NOT grant access to another task/session.
- Task authority MUST retain the existing creator/assignee/dispatcher/explicit-task-grant policy and agent-owner answering relationship. Thread authority MUST require access/modify of the child session or its recorded parent relationship. Siblings MUST NOT gain access merely by sharing an agent.
- The command namespace is independently gated. This release MUST NOT automatically grant `execute:group:decisions`, change permission ceilings, or reinterpret `owner`/`--by` as authenticated human approval.
- Caller identity and relay provenance MUST include authenticated context identity even when it is not duplicated in the outer tool context. The waiting session MUST NOT answer, including via a different session name for the same key or a forged `--by`. Tasks use the active assignment; threads use the pinned child. Canonical session rename MUST update active task session references atomically, while preserving historical decision provenance and checkpoint timing. An explicit authorized parent/operator records the answer. Ordinary thread text MUST NOT be parsed or guessed as an answer.
- Turns narrowed by a user overlay MUST NOT create deferred decision work.

## Lifecycle and migration

- There MUST be at most one open row per `(origin_type,origin_id,key)`.
- Re-ask MUST keep id, askedBy and askedAt, update question/owner/blocks, increment revision and append history when content changes. An identical retry MUST NOT create another question notification.
- Answer MUST identify the exact decision id, close it once, append history and never edit the answer later. Reusing a key after answer creates a new id. An old id MUST NOT answer the new question.
- A single transaction MUST write the decision, history and delivery obligation. Task event projections MUST be in the same transaction.
- Migration from `task_decisions` MUST preserve every row, id, status, text, owner, actor and timestamp and keep `task_events` untouched. Migration MUST be atomic, fail on conflicting ids, and be idempotent on reopen. It MUST NOT enqueue notifications for migrated decisions.
- The generic store MUST retain history when an origin is deleted; orphaned history remains inaccessible through ordinary origin reads. No cascade silently erases a decision.
- Deployment must migrate with an operator-approved backup. This PR validates only isolated fixtures; it MUST NOT migrate the running production DB.

## Thread delivery

- A thread question MUST be presented in that thread and prioritized on its programmatic root card. A root written by a person MUST NOT be edited. Thread summaries MUST expose `openDecisionCount`.
- Any open decision on the thread MUST prevent closure, regardless of blocks or owner. An answered decision with an undelivered/uncertain answer MUST also prevent closure. The check and close MUST be atomic. No force/discard escape exists.
- The answer envelope MUST be frozen with the recorded origin and caller provenance in the answering transaction. Retrying MUST NOT rewrite the answer.
- A claimed publication MUST re-read the stored payload; a stale reconciler batch MUST NOT replace a frozen envelope. Publication MUST use a stable delivery id and durable pending/failed state with bounded backoff. The existing thread reconciler drains due effects. The outbound outbox owns Slack transport retry; the answer receipt owns runtime admission.
- Before publication AND admission, chat, child key, live child and active subscription MUST still match. The frozen envelope MUST carry the waiting session key; runtime identity resolution MUST recheck it after asynchronous preflight so a reused name cannot receive the answer. Rename may change the publish name, never the pinned session key. Missing/replaced children MUST fail closed.
- Consumer admission MUST validate the stored envelope and destination, durably claim it, and dispatch only the stored payload. Duplicates after receipt MUST NOT start another turn, independently of the NATS dedup window.
- `published` MUST NOT mean delivered. For answers, `delivered` means accepted by the dispatcher, not successful work completion. For questions, it means handed to the durable outbound outbox, which owns transport delivery and retry.
- Decision prompts MUST bypass volatile debounce and MUST reject a missing assigned agent rather than fall back to another agent. A verified rejection before queueing is retryable and MUST NOT be marked delivered. A crash or exception after admission starts creates uncertainty. Expired admission claims MUST become `uncertain`; they MUST NOT auto-repeat. Only the local operator may resolve uncertainty with `received|not_received` plus recorded trace evidence. `received` acknowledges admission; `not_received` makes the original id retryable. Agent/runtime/gateway callers and daemon-spawned shell automations MUST be refused.
- No observer, signals producer, followup or checkpoint integration is introduced.

## CLI

`ravi decisions ask --task <id>|--thread <child> --key <key> --ask <text> [--owner human:<contact>|agent:<id>|unassigned] [--blocks]`

`ravi decisions list [--task <id>|--thread <child>] [--all] [--limit <n>] [--offset <n>]`, `show <id>`, `answer <id> --text <text> [--by <label>]`, `retry <id>`, `resolve-delivery <id> --outcome received|not_received --evidence <finding>` all support JSON.

Thread ask/answer and retry/resolve-delivery MUST require `--execute`. Task ask/answer remain immediate ledger writes. Validation and origin authorization precede the brake; preview MUST write no decision, audit or effect. Errors: 1 execution/not-found/self-answer/not-open; 2 usage; 3 confirmation.

Task mutations move from `tasks decide|answer` to this namespace; no deprecated CLI aliases remain. Task attention/show remain task projections. Generated SDKs and OpenAPI MUST match the new registry.
