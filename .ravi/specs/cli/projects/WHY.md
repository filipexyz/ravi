# Projects agent-first CLI contract / WHY

Projects are the alignment layer, but the surface is not read-mostly: two ops
launch real execution. `projects tasks dispatch` is a thin front for the task
runtime dispatch (same effect as `tasks dispatch`, which is already braked —
an unbraked twin here would be a trivial brake bypass), and
`projects workflows start` instantiates a live workflow run that the runtime
then coordinates. `fixtures seed` goes further and RESETS the canonical demo
fixtures before reseeding, and `resources import` writes an arbitrary batch of
links in one call. Those four got the brake. The rest of the surface (`init`,
`create`, `update`, `link`, `attach`, `resources add`) stays immediate: each is
a single reversible substrate write, and `tasks create|attach` without
`--dispatch` only records/plans — braking them would put exit-3 friction inside
the normal alignment loop.

Implementation findings specific to this wave:

- The service layer is split: `getProjectDetails` returns `null`, everything
  else throws typed message strings (`Project not found:`,
  `Workflow run not found:`, `Workflow node K not found in run R.`,
  `Task not found:`). One rethrow helper maps all of them by message shape,
  after letting `ContractError` pass untouched — the projects file wraps every
  command body in a legacy try/catch, so without the rethrow-first rule the
  brake's exit 3 would be flattened into a generic exit 1.
- `listProjects` has no visibility filter (unlike agents/contacts), so
  suggestions can be built from the raw list without leaking anything that
  `projects list` would not print anyway.
- Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
  `acceptedFlags`.
