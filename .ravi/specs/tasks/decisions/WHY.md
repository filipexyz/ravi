# Task Decisions / WHY

## Why this capability exists

The task runtime could already express `blocked`. That single state had to carry two
different situations:

1. an obstacle the worker hit (a failing dependency, a broken environment);
2. a question that a specific person owes an answer to.

They behave differently. An obstacle is resolved by whoever unblocks it; a question is
resolved only by its owner, and the answer itself is the record of the decision. Because
`blocked` stored a free-text reason, a question had:

- no key, so the same question re-asked looked like a new blocker;
- no owner, so nothing could say who was expected to answer;
- no answer record, so "who decided this and when" lived only in chat;
- no deterministic read, so `attention` had to be rebuilt from prose by an LLM observer.

In practice the operator could not answer the only question that matters when watching a
fleet: **what is waiting on me right now?**

## Why not extend the status enum

A decision is not a lifecycle phase of the task. The task keeps running (or stays blocked,
or waits) while a question is pending. Adding `parked` or `needs_decision` to `TaskStatus`
would have forced every existing consumer — automations, filters, checkpoints, the
observer, the channel renderers — to learn a state that usually coexists with the current
one. It would also make "the task is in_progress" and "the task is waiting on a human"
mutually exclusive, which they are not.

So the decision is metadata: a separate table, its own events, and `parked` as a derived
label computed at read time (`open + blocks + owner=human` on a non-terminal,
non-archived task).

## Why the answer is attributed and immutable

`answered` rows are never rewritten. If the same question comes back, it is a new row with
the same key. That keeps two properties that matter operationally:

- the age of an open question is honest (`re-decide` preserves `askedAt`/`askedBy` and only
  updates the question text, owner and `blocks`);
- an answer cannot be silently edited after the fact, so the record can be trusted as
  evidence.

## Why the worker cannot answer its own decision

The whole point of the primitive is to move a question out of the worker and onto its
owner. If the worker could close it, `blocked` with extra steps would return. The check is
by **active assignment session** rather than by a `--by` argument, so provenance text cannot
be used to bypass authority.

## Why no stall or blocked detection lives here

The observer, the checkpoint runner and the signals plane already own "is this work still
moving". Duplicating that here would create a second, weaker detector. `attention` reads
decisions and nothing else; the new events are the hook for a future signals producer.

## Alternatives considered

- **A field on the task row** (`pending_question`): loses history, cannot support more than
  one open question, and rewrites the record on every re-ask.
- **A task comment plus a tag**: no key, no owner, no immutability, and comments are prose
  that every reader has to interpret.
- **A separate decisions aggregate root**: over-modeled. Decisions belong to exactly one
  task and die with it; a foreign key with cascade covers the lifecycle.
- **Reusing `blocked` with structured metadata**: keeps the conflation this change exists
  to remove, and leaves `blocked` meaning two things.
