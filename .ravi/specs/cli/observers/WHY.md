# Observers agent-first CLI contract / WHY

Observer rules are the durable routing config of the Observation Plane: they
decide which sidecar sessions receive events from which source sessions. The
domain has exactly one destructive op — `rules rm` — and its only reverse is
recreating the rule by hand, so it got the write brake. Everything else stayed
immediate on purpose: `refresh` is the reconciliation loop (it disables stale
bindings without deleting history), `rules set` is an idempotent upsert,
`enable/disable` are a reversible pair, and `profiles init` is a scaffold that
already refuses to overwrite without `--overwrite`. Braking those would put
exit-3 friction inside the routine observe/reconcile loop for no risk
reduction.

Two decisions worth keeping visible:

- `OBSERVER_NOT_FOUND` is one code for three resources (binding, rule,
  profile). The message names the resource and the suggestions come from the
  matching list, so an agent branching on `error.code` needs one branch and the
  human-readable part stays precise. Splitting into three codes bought nothing:
  no caller distinguishes them programmatically.
- Session refs reuse `SESSION_NOT_FOUND` from `cli/sessions`, including its
  deliberate absence of suggestions: scope isolation masks unauthorized
  sessions as not-found, and suggesting real session names from an observers
  error would leak exactly what the isolation hides.

`dbSetObserverRuleEnabled` throws on unknown ids instead of returning null, so
`enable/disable` pre-check with `dbGetObserverRule` — the same
throw-vs-null asymmetry `cli/tasks` documented for `getTaskDetails`.

Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope because
`observers` is registered in `AGENT_CONTRACT_DOMAINS`.
