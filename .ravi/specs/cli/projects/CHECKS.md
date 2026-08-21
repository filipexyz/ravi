# Projects agent-first CLI contract / CHECKS

## Checks

- `projects show <unknown-ref> --json` MUST exit 1 with the `PROJECT_NOT_FOUND`
  envelope and up to three `suggestions` of real project slugs/titles, and the
  same envelope MUST come out of service-layer throws (`update`, `link`,
  `workflows attach`, `tasks create|attach|dispatch`, `resources add|import`).
- `projects resources show <project> <unknown-ref> --json` MUST exit 1 with
  `RESOURCE_NOT_FOUND` and suggestions from that project's real resource
  ids/labels/locators.
- An unknown workflow run or node reached through the projects surface MUST
  exit 1 with `WORKFLOW_RUN_NOT_FOUND` or `WORKFLOW_NODE_NOT_FOUND` (node
  suggestions come from the linked run's node keys).
- `projects tasks dispatch` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the dispatch `plan`, and MUST NOT dispatch anything —
  including the pre-resolved agent/session defaults in the plan.
- `projects workflows start` and `projects fixtures seed` without `--execute`
  MUST exit 3 and MUST NOT start or reseed anything; with `--execute` the
  effect MUST happen. The fixture plan MUST use only `ownerAgentId` and
  `resetsCanonicalFixtures:true`, never free-form effect text.
- `projects resources import` MUST create validated local links immediately
  without `--execute` and remain `kind: "mutate"`.
- Validation MUST run before the brake: an unknown project ref on a braked op
  MUST exit 1 with `PROJECT_NOT_FOUND`, never exit 3 with a bogus plan.
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the legacy try/catch MUST rethrow `ContractError`
  and the registry dispatcher MUST preserve `ContractError.exitCode`.
- `projects list --fields a,b,c --json` and
  `projects resources list <project> --fields a,b,c --json` MUST return items
  containing only the requested fields.
- Unknown or empty selections on `projects list`, `projects next`, and
  `projects resources list` MUST exit 2 with `USAGE_ERROR` and
  `acceptedFields`; a valid field mixed with an unknown one MUST NOT produce a
  partial success payload.
- Unbraked writes listed in the spec (`init`, `create`, `update`, `link`,
  `workflows attach`, `tasks create|attach`, `resources add|import`) MUST keep
  immediate-write behavior, and the shipped `projects` skill MUST list them
  explicitly as unbraked.
- `bun test src/cli/commands/projects.test.ts` SHOULD pass after any change to
  the projects contract surface.

## Read-only facade checks

- Run `bun test src/projects/read-facade.test.ts`; missing databases MUST stay
  missing, incompatible schemas MUST remain byte-identical, and ambiguous
  project/resource references MUST fail closed.
- Run `bun test src/cli/commands/projects-read-process.test.ts` without
  `RAVI_NO_AUDIT` or `RAVI_SUPPRESS_AUDIT_EVENTS`; stderr MUST stay empty and
  durable state MUST remain identical.
- `projects next --json` over more than 20 projects MUST return 20 entries,
  `hasMore: true`, and a deterministic next command.
- `projects list --status bogus --json` MUST return
  `INVALID_PROJECT_STATUS` with the valid values, never `COMMAND_FAILED`.
- `projects resources list <project> --type bogus --json` MUST preserve
  `INVALID_PROJECT_RESOURCE_TYPE`; the generic usage mapper MUST run only
  after domain-specific error mapping.
- Every prepared read query MUST be finalized before the read-only database is
  closed, including Windows where a leaked statement keeps the file locked.

## Compact projection correction checks

- Exercise empty, comma-only, trailing-comma, and embedded-empty-token
  `--fields` values through the real process. Every case MUST exit 2 with
  `USAGE_ERROR` and `acceptedFields`.
- Select an absent optional project field and an absent optional resource
  field. The projector and real process MUST return the requested key with
  `null`, never `{}`, while preserving item count and order.
- Runtime Zod, OpenAPI, TypeScript, and Swift contracts MUST describe a selected
  originally optional field as required in that compact variant and nullable.
  Originally required fields MUST remain non-null.

## Swift key-presence and active-WAL checks

- Generate a required-nullable top-level Swift return model. Missing required
  keys MUST fail, explicit `null` MUST decode and re-encode as `null`, required
  non-null values MUST remain strict, and truly optional absent keys MUST be
  omitted.
- Generate a compact projection Swift model. `{}` MUST fail; a selected
  nullable key with `null` MUST survive a decode/encode round-trip as an
  explicit `null`; and a selected non-null key containing `null` MUST fail.
- Run the compiler-backed Swift round-trip wherever `swiftc` is available. A
  host without `swiftc` MAY run source-generation assertions, but MUST leave
  compilation as an explicit CI gate and MUST NOT report local compilation as
  passing.
- Run `bun test src/cli/commands/projects-read-process.test.ts` with a WAL
  writer connection kept open. The Ravi read MUST execute in a separate process
  and both `ravi.db` and `ravi.db-wal` MUST be byte-identical afterward.
