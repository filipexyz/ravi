---
id: sessions/turn-output
title: Turn Output
kind: capability
domain: sessions
capabilities:
  - turn-output
  - history-materialization
  - delivery-vs-content
tags:
  - sessions
  - runtime
  - history
  - providers
  - attach
applies_to:
  - src/runtime/host-event-loop.ts
  - src/runtime/assistant-transcript.ts
  - src/runtime/session-output-target.ts
  - src/db.ts
  - src/router/sessions.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Turn Output

## Intent

A turn produces text. Three different things happen to that text, and conflating
them loses work: it is **materialized** into session history, it is **delivered**
to a chat, and it may **end** in a failed or incomplete run.

Today the three are decided together, so a session without a chat target keeps no
history, and a provider that separates `commentary` from final answer can complete
real work that leaves no durable trace. This capability separates them.

## Terms

- **Utterance**: one assistant text block produced by the provider inside a turn.
- **Class**: `final` or `commentary`. Providers that declare a phase set `commentary`
  for intermediate blocks; providers that declare nothing default to `final`.
- **Materialization**: a durable history row for an utterance, with its class.
- **Delivery**: external projection of an utterance to a chat resolved by
  `sessions/attach`.
- **Run health**: the terminal state of the turn (`complete`, `failed`,
  `interrupted`, `incomplete`) plus its usage accounting.

## The Three Separations

| Concern | Owner | Question it answers |
| --- | --- | --- |
| Materialization | turn output | did this text become durable history? |
| Delivery | `sessions/attach` | which chat, if any, receives it? |
| Run health | runtime/provider | did the turn finish, and with what usage? |

Materialization MUST NOT be conditioned on delivery. Delivery MUST NOT be
conditioned on materialization succeeding. Run health MUST NOT reclassify or erase
materialized text.

## Invariants

1. Every non-silent utterance MUST be materialized, **whatever its class**.
   Delivery is never a precondition for history.
2. Materialization MUST record the class. A `commentary` row is visible in history
   but MUST NOT count as the turn's final answer.
3. Delivery resolution MUST be evaluated per utterance and per attach binding.
   `unresolved` means "this session has no external target" — it MUST NOT mean
   "discard the content". Dropping history because a chat target is missing is
   forbidden.
4. A delivery failure MUST NOT remove, rewrite, or reorder the materialized row.
   Delivery attempts and outcomes are recorded separately from content.
5. Run health MUST be recorded independently of content: `provider_inactive`,
   `turn.failed` and `turn.interrupted` end the turn and MUST be persisted with
   their reason and usage.
6. A turn that ends without a `final` utterance MUST still keep the commentary it
   produced and MUST be marked `incomplete`, so readers do not conclude "no work
   happened".
7. A turn that failed or was interrupted MUST NOT report token counters as zero
   when the provider reported usage. When usage was NOT reported, counters MUST be
   persisted as `NULL` (absence of a measurement) and rendered as `unknown` — never
   as `0`. A consumer that sums tokens MUST treat `NULL` as unknown and MUST NOT
   add it as zero, so a missing measurement can never masquerade as "no work".
8. Replaying the same utterance within the same turn MUST NOT create a second row.
   Dedupe applies to exact same-turn replay only; it MUST NOT suppress a new
   utterance that merely resembles an older one.
9. Commentary MUST NOT be treated as a hidden channel: it is history, it is
   readable by recap, observer, task observer and `sessions read`.
10. A blocked or failed turn MUST NOT be the reason a session looks idle. Any
    consumer that judges activity from history or counters MUST see either rows or
    an explicit `failed`/`incomplete` marker.

## Decisions (default-overridable)

- **Usage when the provider is silent** (default): persist `NULL`, render `unknown`,
  never `0`. Readers that sum tokens treat `NULL` as unknown.
  *What changes in `sessions info`:* `totalTokens` / `inputTokens` / `outputTokens`
  become nullable. A failed turn without usage prints `unknown` instead of `0`, and
  any aggregate that today sums these fields must skip `NULL` rather than add zero.
  Overridable: if measurement needs to stay numeric for a consumer, the override is
  an explicit `usage_state` column (`reported | unknown`), not a sentinel `0`.

## Acceptance Criteria

- A codex turn with three `commentary` items and one final answer yields four
  history rows: three flagged commentary, one flagged final.
- A turn with two `commentary` items that then fails with `provider_inactive`
  yields two history rows, one turn record with reason and usage, and a task
  observer that sees activity.
- A session with no bound chat materializes every utterance, performs zero external
  deliveries, and logs one `unresolved` line without losing content.
- A task work session that runs a multi-minute tool loop leaves a materialized
  transcript, not an empty session.
- Replaying the same utterance inside a turn yields one row.
- `sessions read` on a failed turn shows its text; `sessions info` reports the
  provider's usage when it was reported, and `unknown`/`null` (never `0`) when it was
  not.
- An aggregate that sums tokens over a window containing an unknown-usage turn
  reports the same total as over that window without it, plus an `unknown` count.

## Known Failure Modes

- A provider that never emits a `final` phase: every turn looks incomplete. The
  contract must degrade to "all commentary is history", not to "no history".
- A consumer that reads only counters (`systemSent`, tokens) instead of rows
  concludes a session is dead while it produced work.
- Dedupe logic generalized from mashed-replay can silently swallow a real
  utterance that repeats an earlier one.
- Inactivity classification (run health) leaking into content decisions, so a
  watchdog turns into a data-loss path.
- A consumer that coerces `NULL` usage to `0` recreates the original bug: work
  happened, the counters say nothing happened.

## Implementation Status

- `src/db.ts`: assistant rows carry `utterance_class` (`final` | `commentary`; NULL is a
  legacy final row) and `turn_id`. `saveMessage` skips an exact same-turn replay
  (same session, turn, role, class and content) and writes any other row.
  `isFinalAssistantMessage` (`src/runtime/utterance-class.ts`) is the one predicate for
  "this row may stand as the answer".
- `src/runtime/host-event-loop.ts`: every non-silent utterance is materialized with its
  class and turn id before, and independently of, delivery. Delivery cleanup cannot rewrite the materialized provider block; a history write failure is logged and does not stop delivery. A terminal turn with
  commentary and no final utterance is recorded with `output_state = 'incomplete'`.
- `session_turns`: token and cost columns are NULL when the provider reported no usage
  (`turn.failed`, `turn.interrupted`); reported terminal usage is preserved, including Codex goal-chain usage and Claude failure results. `output_state` holds `final` or `incomplete`.
- Readers: `sessions send -w`, Library request turns and the Knowledge curator take only
  final rows as the answer; replay detection compares against final rows only.
  `sessions info`, `sessions trace` and `agents session` print `unknown` for NULL usage,
  and the 24h aggregate skips NULL rows and reports `unknownUsage=<n>`.

## Validation

- `bun test src/runtime/assistant-transcript.test.ts`
- `bun test src/runtime/` (turn output paths)
- manual: dispatch a task to a provider with commentary phases and confirm rows
  exist in `~/.ravi/chat.db` for the work session.
