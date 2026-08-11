# Tasks agent-first CLI contract / WHY

Tasks are the surface agents use the most: they create, dispatch, report and
close tracked work through `ravi tasks`. A misunderstood `dispatch` is not a
local mistake — it starts a real agent session doing real work, and a stray
`deps rm` or `automations rm` silently deletes coordination config. Those three
are exactly the ops that got the write brake; the rest of the lifecycle
(`create`, `done`, `block`, `fail`, `report`, `comment`) stays immediate because
braking the core reporting loop would put exit-3 friction inside every task
turn, and each of those transitions has a reverse path.

Two implementation findings shaped this wave and benefit every later domain:

- `getTaskDetails` throws on unknown ids instead of returning a null task, so
  the not-found envelope needs a helper that catches the throw
  (`getTaskDetailsForContract`) — checking `details.task` alone is dead code.
- The registry dispatcher used to flatten any thrown `ContractError` into
  `Error: <msg>` + exit 1. Agents always run the CLI with `RAVI_*` envs set,
  which makes the contract helpers throw instead of exiting — so the brake was
  invisible exactly for agent callers. The dispatcher now preserves
  `ContractError.exitCode` (1/2/3). The pilot did not cover this path.

Parser-level usage errors (unknown flag, missing argument) are exercised in
`crm.test.ts` against a real commander tree; `tasks.test.ts` mocks the decorator
layer, so per-domain tests cover the command-body contract and the shared parser
behavior is validated once in the crm suite.
