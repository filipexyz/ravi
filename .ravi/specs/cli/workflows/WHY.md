# Workflows agent-first CLI contract / WHY

The workflow substrate turns declared specs into live runs whose node runs gate
real coordinated work. Two ops earned the brake, for different reasons:

- `runs start` is the same class as `projects workflows start` (already braked
  in `cli/projects`): a misunderstood start instantiates node runs, arms
  gates and invites task dispatches against the wrong spec. Keeping the
  project-level wrapper braked while the direct op ran immediately was a
  bypass, not a design.
- `runs archive-node` looked like housekeeping but is the most irreversible op
  in the domain: there is no unarchive anywhere in `src/workflows/service.ts`,
  archived nodes are excluded from the aggregate status computation, and
  `assertNodeRunMutable` permanently rejects release/skip/cancel/attach on
  them. `cancel` at least leaves a terminal-but-visible node; `archive`
  removes the node from the run's arithmetic forever. Destructive verdict →
  brake.

`cancel` was deliberately left unbraked. It is the emergency stop: a live node
keeps gating the aggregate (and may hold an active task attempt) until it is
cancelled. Putting an exit-3 dry-run in front of the stop action would delay
exactly the operation that limits damage — the same anti-safety rationale that
keeps `tasks block/fail` unbraked in `cli/tasks`.

One mapping subtlety shaped the not-found envelopes: the service throw
`Workflow node K not found in run R.` fires both when the node is unknown and
when the whole run is unknown (an unknown run simply has no node rows). Every
node-level op therefore pre-resolves the run with `getWorkflowRunDetails` so
agents get `WORKFLOW_RUN_NOT_FOUND` with run suggestions instead of a
misleading node error.

There is no shipped `workflows` skill — a known gap registered in the SPEC.
Until one exists, `docs/workflow-substrate-v0.md` is the teaching surface and
now carries `--execute` on both braked ops. The `workflows` domain is also not
yet in `AGENT_CONTRACT_DOMAINS` (`src/cli/index.ts`, untouchable in this
migration), so parser-level usage errors keep commander defaults until that
one-line registration lands.
