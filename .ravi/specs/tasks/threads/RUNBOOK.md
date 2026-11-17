# Runbook

Use an isolated RAVI_STATE_DIR before loading branch code or running tests. Do not run
migrations against a live installation to validate this feature. This PR is not a deploy.

`ravi tasks create "Work" --instructions "Return a result" --idempotency-key <operation>`
can create work without a channel or report session. The returned task carries `threadId`;
`ravi threads show <thread-id>` exposes its entries and handoffs. `ravi tasks dispatch`
chooses the executor; `ravi tasks done` is the successful lifecycle writer.

Inspect `activeAssignment.executionStatus` through task details. `pending` can retry its
frozen publication. `admitted` has crossed the admission boundary. `uncertain` or a stranded
`accepting` requires trace reconciliation; do not dispatch a replacement merely because
there is no visible result. Phase 1 intentionally provides no blind reset command.
`legacy` denotes an imported assignment with no historical admission receipt; preserve its
pending runtime messages and reconcile manually before issuing fresh work.

Rollback must not delete Thread records or admission receipts. Reverting to code that does
not understand them is not a safe replay strategy: pause new dispatch and reconcile pending
and uncertain assignments before rolling back the runtime.
