# Agents agent-first CLI contract / WHY

Agents are the identities everything else routes through: a deleted agent takes
its config and routing role with it, a reset throws away session context that
cannot be rebuilt, and a permissions change rewrites what the agent (and the
automations running on its behalf) is allowed to do at runtime. Those are
exactly the three ops that got the write brake. The rest of the surface
(`create`, `set`, `sync-instructions`, `debounce`, `spec-mode`) stays immediate
because each of those writes has a reverse path (`set` it back, re-run the
sync, toggle it off) and braking routine configuration would put exit-3
friction inside every setup flow.

Two decisions specific to this wave:

- `agents permissions` is one op with two personalities: `permissions <id>` is
  a read and must keep exit 0, while `permissions <id> <profile>` (or
  `--capabilities`/`--clear-capabilities`) mutates runtime authority. The brake
  sits after the read-only early return and after profile validation, so a bad
  profile is still a plain validation failure and only real profile changes hit
  exit 3 — with `before`/`after` in the plan so the caller reviews the actual
  authority delta.
- `AGENT_NOT_FOUND` suggestions are built from the same
  `filterVisibleAgents(getScopeContext(), ...)` filter that `agents list` uses.
  Agent ids are public through `agents list`, so suggesting them leaks nothing
  new — but reusing the list filter (instead of `getAllAgents()` raw) keeps the
  scope cloak intact for agents the caller cannot see.

One implementation finding: the legacy `delete` wrapped resolution, the service
call and the success/not-found branches in a single try/catch that flattened
every error into `fail("Error: ...")`. Contract helpers throw `ContractError`,
so leaving them inside that block silently converts exit 3/1 envelopes into a
generic exit 1. The migrated op resolves and brakes outside the try/catch and
only wraps the `deleteAgent` service call.

Parser-level usage errors (unknown flag, missing argument) are exercised in
`crm.test.ts` against a real commander tree; `agents.test.ts` mocks the
decorator layer, so per-domain tests cover the command-body contract and the
shared parser behavior is validated once in the crm suite.
