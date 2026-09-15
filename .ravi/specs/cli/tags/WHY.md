# Tags agent-first CLI contract / WHY

Tags are the connective tissue between planes: instances stamp default tags,
tag rules move contacts across lifecycle tags, observers react to tags. An
agent that mistypes a slug used to get a bare `Tag not found` (or a raw DB
throw on `set`/`attach`) with nothing to recover from; the envelope plus
suggestions turns that dead end into a one-retry fix.

The headline decision of this wave is a NEGATIVE one: no `tags` op received
the write brake. Every mutation on this surface is unitary and reversible —
`create` adds, `set` re-sets, `attach`/`detach` mirror each other — and the
destructive op that would deserve exit 3 (`tags rm`) simply does not exist in
the CLI. Braking reversible unit writes would put exit-3 friction inside every
tagging loop (tag rules, observers setup, CRM flows) for zero protection. The
spec records the rule that matters for the future: if a destructive tags op is
ever added, it ships with the brake.

Two smaller findings:

- The DB layer reports unknown tags by THROWING (`dbUpdateTagDefinition`,
  `dbUpsertTagBinding`), so the not-found envelope needs the rethrow-wrapper
  pattern from `cli/contacts`, not a null check.
- `dbDeleteTagBinding` collapses "tag missing" and "binding missing" into one
  `false`; the command re-checks the definition to keep `TAG_NOT_FOUND`
  precise while leaving the missing-binding case on the legacy text path.

There is no `tags` skill teaching this surface — registered as a gap rather
than silently absorbed, matching how `cli/chats` recorded its missing skill.
