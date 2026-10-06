# Bases agent-first CLI contract / CHECKS

## Checks

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
