# CRM Agent-First Facade / WHY

## Rationale

The existing CRM commands are useful and established, but a direct mutation
does not give an agent a durable boundary between deciding, obtaining human
approval, applying, and determining what actually happened. The facade adds
that boundary inside the existing CRM domain instead of creating a second CRM
model or database.

A persisted plan makes the proposed target and arguments reviewable across
processes. Its 15-minute lifetime limits stale intent, while its semantic hash
prevents a reviewed plan from being changed after the fact.

Approval routing and the expected sender come from the active Ravi runtime
because caller-owned `source` or `agent` flags would let the same caller choose
who is allowed to approve. Binding the delivered message id and exact sender to
the plan makes the existing transport receipt durable and auditable. Channel,
account, chat, and optional thread are stored as context, but only message and
sender ids are enforced on the inbound response today.

The journal is written before dispatch because a crash around dispatch creates
an ambiguous result. Independent readback, rather than the mutation call alone,
evaluates the operation's primary success predicate. A divergent readable
result is `partial`; a handled ambiguous result is `unknown`; a process exit can
leave `applying`. None authorizes a duplicate effect.

Legacy writes remain available because the facade is an incremental adoption
path. Global replacement would silently change current consumers and lifecycle
behavior beyond the nine implemented operations.

## Rejected Alternatives

- A new CRM domain or database: rejected because it would duplicate records and
  create synchronization problems.
- Immediate mutation followed by approval: rejected because approval would no
  longer guard the effect.
- Caller-provided approval source or agent identity: rejected because the
  caller would control the approval boundary.
- Automatic retry after an execution or sensor failure: rejected because the
  first effect may already have committed.
- Treating a successful mutation return as proof: rejected because only
  readback can confirm the resulting CRM state.
- Forcing all legacy CRM writes through the facade in this change: rejected as
  a breaking migration that needs its own consumer inventory and rollout.
