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
- Every `bases` command MUST pass the confirmation, JSON, pagination, and
  return-schema coverage tests.
- `publishInboxNatsEvents` MUST publish a `category: "bases"` item only on
  `ravi.console.inbox.item`, unchanged.
- No `bases` help text, plan `effect`, `suggestedAction`, or message may point
  to a Console UI for Bases; `bases charts archive` and `bases views archive`
  plans MUST name the generated Pages that stop working
  (`grep -n "Console" src/cli/commands/bases.ts` shows only project, scope,
  URL, and server-side wording).
- The `bases` and `pages` skills MUST name only the seven `ravi.bases.*` ids listed in
  SPEC "Generated Pages". Every page example MUST ship with `--uses` covering
  the ids it calls, and the skill MUST say that `--uses` is the union of the
  ids called by every page on the same host.
- The skill MUST tell the agent, when it grants `page_viewer`, to tell the
  person which host (all routes) gains read or write access to which view.
