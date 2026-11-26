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

## Scope, source and replacement

- Every decision MUST carry a scope: `origin` (its thread or task, the default), `agent:<id>`, `project:<id>` or `org`. The asker MAY propose a scope; the answer settles it, widening or narrowing the proposal. While open, the scope is only a proposal and reaches no turn.
- An answer whose scope is wider than its origin MUST come from the local operator, or with an owner source whose message names both the decision id and the scope literal (`org`, `agent:<id>`, `project:<id>`): the owner approves the audience, not only the answer. A quoted passage alone never widens. An agent MUST NOT widen a decision on its own authority, whatever its grants. A proposed wide scope binds an answer that does not narrow it. A wide answer MUST fit 2000 characters, since every turn in scope carries it whole.
- The local operator is a terminal caller with no agent, session, runtime context or invocation context and the operator's authority; a daemon-spawned automation (shell cron and triggers included) is never the operator here.
- A source MUST be one stored message written by the decision's human owner, at or after the time the current wording was asked (`revised_at`, set on insert and on every re-ask that changes it; rows from before the column read their last change when re-asked, else `asked_at`; provider time read as seconds below 10^12, else ingestion time), whose text is read from `content.text` or its text blocks, in the decision's chat or a direct chat, and bound to this decision: it names the decision id, or the recorder quotes (`--source-quote`) a passage it contains (whitespace and case ignored). The quote, or the message when it names the id, MUST be stored on the decision as `source_excerpt` with `source_message_id`. Every refusal MUST share one code and text. A provider-id lookup MUST apply owner, time and chat eligibility before any row limit.
- Every runtime turn of a non-sentinel agent MUST carry the answered decisions that cover it: org, the turn's agent, and thread decisions whose waiting session is this session. Project decisions MUST NOT be mounted until a session's project is verified (a session goal's project is a label the session can write). A live runtime MUST refresh the list on the next turn when it changed since launch (new, replaced or removed decisions), prepending the current list; an unchanged list adds nothing. Answers are mounted whole, never cut: wide answers are capped at answer time, and a thread's own answer reaches only that thread. Newest answer first, at most 20, question and answer quoted as JSON data, each with its id and scope. Open and superseded decisions MUST NOT appear; owner contact ids MUST NOT appear. Answer whitespace MUST be kept as written (JSON-quoted). A store capacity failure MUST degrade to a note, not fail the turn.
- An answered decision MAY be replaced by a later answered one (`answer --supersedes <old>` in the answering transaction, or `supersede <old> --by <new>`). The old one MUST become `superseded` with `superseded_by`, keep its answer and history, and leave every turn. Replacing an origin decision needs answer authority on its origin and is refused to its waiting worker; replacing a wider one needs the local operator or a replacement with an owner source at the same scope or org. The replacement MUST be answered at or after the decision it replaces. A decision MUST NOT replace itself; open decisions neither replace nor are replaced. The replaced decision's answer deliveries still `pending|failed|publishing|published` MUST become `superseded` (a publication completing afterwards changes nothing), and neither publication nor admission may hand a superseded decision's answer to the waiting turn.
- The store MUST settle a scope only when the answering path passes it; an answer recorded without one stays in its origin, whatever scope was proposed. `supersede` returns only the replaced decision's id and new state, never its record.
- Decision waits (`sessions report --awaiting decision`) MUST propose the origin scope.

## Thread delivery

- A thread question MUST be presented in that thread and prioritized on its programmatic root card. A root written by a person MUST NOT be edited. Thread summaries MUST expose `openDecisionCount`.
- Thread summaries MUST also expose `pendingAnswerCount` and `uncertainAnswerCount`, counting distinct decisions by `origin_type='thread'` and lifecycle `requestId`. Pending answers have at least one `kind='answer'` delivery outside `delivered|superseded`; uncertain answers are the subset with an `uncertain` delivery. `accepting` is pending, not uncertain. Open questions and older answers in transit MUST be counted independently. The projection MUST use read-only SQL aggregation without loading question text, reconciling, publishing or retrying. Zero counts MUST NOT imply worker activity or completed work; existing authorization and the atomic close guard remain unchanged.
- Any open decision on the thread MUST prevent closure, regardless of blocks or owner. An answered decision with an undelivered/uncertain answer MUST also prevent closure. The check and close MUST be atomic. No force/discard escape exists.
- The answer envelope MUST be frozen with the recorded origin and caller provenance in the answering transaction. Retrying MUST NOT rewrite the answer.
- A claimed publication MUST re-read the stored payload; a stale reconciler batch MUST NOT replace a frozen envelope. Publication MUST use a stable delivery id and durable pending/failed state with bounded backoff. The existing thread reconciler drains due effects. The outbound outbox owns Slack transport retry; the answer receipt owns runtime admission.
- Before publication AND admission, chat, child key, live child and active subscription MUST still match. The frozen envelope MUST carry the waiting session key; runtime identity resolution MUST recheck it after asynchronous preflight so a reused name cannot receive the answer. Rename may change the publish name, never the pinned session key. Missing/replaced children MUST fail closed.
- Consumer admission MUST validate the stored envelope and destination, durably claim it, and dispatch only the stored payload. Duplicates after receipt MUST NOT start another turn, independently of the NATS dedup window.
- A confirmed pre-dispatch rejection or operator-confirmed `not_received` resolution MUST rotate the persisted transport message ID while keeping the decision delivery ID and frozen answer stable. Ambiguous publication retries MUST reuse the same transport ID; old persisted deliveries retain their original ID until a confirmed refusal.
- `published` MUST NOT mean delivered. For answers, `delivered` means accepted by the dispatcher, not successful work completion. For questions, it means handed to the durable outbound outbox, which owns transport delivery and retry.
- Decision prompts MUST bypass volatile debounce and MUST reject a missing assigned agent rather than fall back to another agent. A verified rejection before queueing (including runtime pool capacity refusal) is retryable and MUST NOT be marked delivered or uncertain. Capacity refusal remains in the existing answer retry ledger rather than creating another recovery owner. A crash or exception after admission starts creates uncertainty. Expired admission claims MUST become `uncertain`; they MUST NOT auto-repeat. Only the local operator may resolve uncertainty with `received|not_received` plus recorded trace evidence. `received` acknowledges admission; `not_received` makes the original id retryable. Agent/runtime/gateway callers and daemon-spawned shell automations MUST be refused.
- No observer, signals producer, followup or checkpoint integration is introduced.

## CLI

`ravi decisions ask --task <id>|--thread <child> --key <key> --ask <text> [--owner human:<contact>|agent:<id>|unassigned] [--blocks] [--scope thread|agent:<id>|project:<id>|org]`

`ravi decisions list [--task <id>|--thread <child>] [--all] [--scope <scope>] [--answered-since <iso|ms>] [--limit <n>] [--offset <n>]`, `show <id>`, `answer <id> --text <text> [--by <label>] [--source-message <id> [--source-quote <text>]] [--scope <scope>] [--supersedes <id>]`, `supersede <id> --by <id>`, `retry <id>`, `resolve-delivery <id> --outcome received|not_received --evidence <finding>` all support JSON. `list --scope org --answered-since <start of day>` is the digest's and the daily status's source of the day's org decisions.

Thread ask/answer, supersede and retry/resolve-delivery MUST require `--execute`. Task ask/answer remain immediate ledger writes. Validation and origin authorization precede the brake; preview MUST write no decision, audit or effect. Errors: 1 execution/not-found/self-answer/not-open; 2 usage; 3 confirmation.

Task mutations move from `tasks decide|answer` to this namespace; no deprecated CLI aliases remain. Task attention/show remain task projections. Generated SDKs and OpenAPI MUST match the new registry.
