# Bases agent-first CLI contract / CHECKS

## Checks

- The first `ravi bases …` call in an agent session MUST return
  `RAVI_SKILL_REQUIRED` naming `ravi-system-bases` and deliver the skill; the
  retry MUST pass. `bases_rows_query` MUST resolve the same gate.
- A `full-access` agent MUST be able to run `ravi skills show bases`.
- `bases rows purge`, `bases archive`, `bases restore`, `bases views archive`,
  and `bases charts archive` without `--execute` MUST exit 3 with
  `WRITE_REQUIRES_EXECUTE` and a `plan`, and MUST NOT call the Console.
- `bases rows purge --execute` MUST POST `.../rows/<row>/purge` with
  `{confirm: true}` and no client hint.
- `bases props delete` without `--execute` MUST send no `confirm`, and MUST
  exit 3 with the Console migration report in `plan.migration`; with
  `--execute` it MUST send `confirm: true`.
- `bases rows add` MUST send the same key in the `Idempotency-Key` header and
  in `idempotencyKey`; `--idempotency-key` MUST override it and a malformed key
  MUST fail with `PAYLOAD_INVALID` before any request.
- Inside an agent session, `bases rows add` and `bases rows update` without
  `--idempotency-key` MUST still write and MUST return `warnings`; with the
  key, or outside an agent session, they MUST return no `warnings`.
- `bases rows query --sort a:desc,b` and `bases aggregate --group-by
  status,prazo:month` MUST pass through the daemon gateway (one string value).
- `bases rows update` without `--expected-version` or `--last-write-wins` MUST
  fail with `PAYLOAD_INVALID` (exit 2) before any Console call.
- A Console `VERSION_CONFLICT` MUST return exit 1 with `consoleError`,
  `requestId`, `current`, and a `suggestedAction` naming the current version.
- Console `details.fieldErrors` MUST appear as `issues` with path
  `["values", <key>]`.
- `PROJECT_ACCESS_DENIED` with stored scopes lacking the Bases scopes MUST
  return `missingScopes` and a `suggestedAction` that mentions `ravi login`.
- A bare HTTP 409 MUST map to `AUTH_PENDING` on `/api/cli/auth/*` and to
  `CONFLICT` on `/api/cli/projects/*/bases/*`; a 409 `CONFLICT` on
  `/api/cli/link` MUST still map to `ACTOR_BINDING_CONFLICT`.
- `bases rows query --all --max-rows N` MUST send identical bodies except
  `cursor` and MUST stop after the page that reaches N.
- `bases rows import` MUST fail with `PAYLOAD_INVALID` on type mismatches
  before the brake, MUST exit 3 with a plan without `--execute`, and MUST use
  the same batch keys when the same command runs again.
- `bases views bind` MUST GET the view, then PATCH the full layout with only
  `widget` changed and `expectedVersion` set to the version read; `none` MUST
  send `widget: null`; a table layout MUST exit 2 with no PATCH (`ravi bases
  views bind` block of `src/cli/commands/bases.test.ts`).
- Every `bases` command MUST pass the confirmation, JSON, pagination, and
  return-schema coverage tests.
- `publishInboxNatsEvents` MUST publish a `category: "bases"` item only on
  `ravi.console.inbox.item`, unchanged.
- No `bases` help text, plan `effect`, `suggestedAction`, or message may point
  to a Console UI for Bases; `bases charts archive` and `bases views archive`
  plans MUST name the generated Pages that stop working
  (`grep -n "Console" src/cli/commands/bases.ts` shows only project, scope,
  URL, and server-side wording).
- The `bases` and `pages` skills MUST name only the eight `ravi.bases.*` ids listed in
  SPEC "Generated Pages". Every page example MUST ship with `--uses` covering
  the ids its own route calls, and the skills MUST say that the host allows
  the union over its active routes (no skill, reference, skeleton or doc may
  still teach "every ship lists the union of every page's ids":
  `grep -rn "união do --uses\|união dos ids de todas\|union of the ids all" src/plugins docs AGENTS.md src/prompt-builder.ts`
  finds nothing).
- The skill MUST tell the agent, when it grants `page_viewer`, to tell the
  person which host (all routes) gains read or write access to which view.
- `bases create`, `props add`, `views create` and `charts create` MUST send
  the same key in the `Idempotency-Key` header and in `idempotencyKey`, with
  no `clientHint` (`creates with idempotency keys` block of
  `src/cli/commands/bases.test.ts`).
- Inside a runtime turn, Bases reads (GET and POST `rows/query`,
  `views/<v>/query`, `charts/<c>/data`) and writes MUST carry
  `x-ravi-actor-contact`; outside a turn none (`Bases reads in a delegated
  turn` block of `src/bases/client.test.ts`).
- `bases subscribe --events/--props/--view` MUST post the filter body;
  unknown events, more than 20 props, and trigger-only flags without
  `--trigger` MUST fail `PAYLOAD_INVALID` before any call.
- `bases subscribe --trigger` from the operator MUST create an enabled
  trigger; from an agent turn a disabled one with `enableCommand`; the same
  subscription again MUST reuse the trigger. The filter MUST match only its
  own subscription's items (`Bases subscription triggers` in
  `src/triggers/__tests__/runner-filter.test.ts`).
- Inside a runtime turn Ravi cannot attribute, every Bases command (reads
  included) MUST fail `ACTOR_UNKNOWN` (exit 3) with no Console call
  (`src/bases/client.test.ts`, `src/cloud-auth/turn-actor.test.ts`).
- A run of a cron job a contact owns MUST send that contact as the actor
  (`x-ravi-actor-contact`, access body `actor`), never refuse locally and
  never act as the operator (`src/access/actor.test.ts`,
  `src/cloud-auth/turn-actor.test.ts`); unlinked, the link flow MUST answer
  `routine` without messaging anyone (`src/identity-link/turn-link.test.ts`,
  `src/cloud-auth/errors.test.ts`).
- A run of a cron job no person owns (`unknown`, an agent) MUST fail `ACTOR_UNKNOWN` with
  `refusalReason: routine_not_operator_owned`, its `jobId` and `ownerPrincipal`, and
  a suggested action that does not send the agent to the person's chat
  (`src/cli/commands/bases.test.ts`, `src/access/actor.test.ts`). A remote
  `ACTOR_UNKNOWN` MUST keep the catalog copy even with a `reason` in its
  details (`src/cloud-auth/errors.test.ts`).
- A shell cron process (`RAVI_AUTOMATION_PRINCIPAL=automation:cron:<id>`, no
  context key) MUST count as a runtime turn: an operator-owned one sends no
  actor, and the classification of a marker naming a contact-owned job sends
  that contact or, ownerless, fails `ACTOR_UNKNOWN` with
  `routine_not_operator_owned` (such a job never runs: connectors 13b); shell
  triggers and jobs MUST NOT be covered
  (`src/cloud-auth/turn-actor.test.ts`).
- `bases views share` without `--execute` MUST exit 3 after reading the
  view and site, with no PATCH; with it, it MUST PATCH `access` at the
  version read with the `page_viewer` added, MUST NOT PATCH when nothing
  changes, MUST fail
  `NOT_FOUND` for an unknown site and `PROJECT_ACCESS_DENIED` for a caller
  without manage, and MUST return the disclosure.
- `bases rows approve|reject` without `--execute` MUST read the row and exit 3
  without a write (an unknown row exits 1), with no note text in the plan;
  `request-approval|approve|reject` without `--expected-version` MUST send
  `lastWriteWins: true` and no read-derived `expectedVersion`, so the same
  key retries as the same request; with `--execute` they MUST write `{state, note?}` (through the view
  with `--view`). `approval_forbidden` MUST surface as
  `PROJECT_ACCESS_DENIED` with `consoleError: approval_forbidden`.
- `bases rows fill` MUST post `{inputsHash, value|error}` with an idempotency
  key; `agent_stale` MUST return `CONFLICT` with the current `inputsHash`.
- The bootstrap floor MUST hold exactly the eight Bases read capabilities of
  SPEC invariant 23 and no `mutate:bases*`, `read:bases.rows:query` or
  `read:bases:aggregate` (`src/permissions/runtime-bootstrap-provider.test.ts`).
- Inbox enrichment MUST add `payload.row` to `bases.approval.*` and
  `bases.agent.requested` items and MUST NOT read a row for
  `bases.rows.bulk_changed` or `bases.agent.backfill`.
