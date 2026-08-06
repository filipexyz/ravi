# Work Objects agent-first CLI contract / WHY

Work Objects are provider-owned external references mutated through domain
adapters. The CLI cannot see what an actionId does: today the only adapter is
tasks (`task.done`, `task.archive`, `task.comment`...), but the registry is
built for future adapters whose actions may be genuinely external and
irreversible ("send", "delete", "deploy"). That asymmetry decided the brake
split:

- `action` is braked. The op executes an OPAQUE identifier — the agent asks
  for "task.done" and the adapter decides what that means. A dry-run showing
  `{ref, actionId, value}` costs one retry and prevents the class of mistake
  where an agent fires a lifecycle action at the wrong object. Yes, through
  the tasks adapter this is stricter than `ravi tasks done` (unbraked in
  `cli/tasks`) — deliberately: `tasks done` names its semantics in the
  command; `work-objects action` does not.
- `update` is NOT braked. Its plan is its input — `--values` is an explicit
  field patch, the adapter validates each field and returns
  `fieldErrors`/`formError`, and `--revision` gives optimistic concurrency.
  Braking it would double-gate a surface already designed as a validated
  form submit.

WORK_OBJECT_NOT_FOUND carries no `suggestions`: candidates would require
enumerating every adapter's objects, which no adapter interface offers
cheaply. The envelope points to the adapter-backed listing instead
(`ravi tasks list`), matching the contract's fallback rule.

The daemon's NATS path (`ravi.work_objects.action`) intentionally stays
unbraked — it serves programmatic integrations (Slack unfurls, Omni) that
already passed their own confirmation UX; the brake targets the typed-command
surface where an agent's misunderstanding is the risk.
