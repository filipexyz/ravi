---
id: cli/bases
title: "Bases agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - bases
tags:
  - cli
  - cloud
  - bases
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - idempotency
applies_to:
  - src/cli/commands/bases.ts
  - src/bases/client.ts
  - src/bases/schemas.ts
  - src/bases/input.ts
  - src/bases/csv.ts
  - src/bases/format.ts
  - src/bases/import.ts
  - src/cloud-auth/client.ts
  - src/cloud-auth/errors.ts
  - src/cli/cloud-error-contract.ts
  - src/cli/skill-gates.ts
  - src/plugins/internal/ravi-system/skills/bases/SKILL.md
  - src/plugins/internal/ravi-system/skills/bases/references/pages.md
  - src/plugins/internal/ravi-system/skills/pages/references/data-pages.md
  - src/plugins/internal/ravi-system/skills/solucoes/SKILL.md
  - src/plugins/internal/ravi-system/skills/bases/references/approvals-agent-columns.md
  - src/plugins/internal/ravi-system/skills/bases/references/events-triggers.md
  - src/inbox/bases-enrichment.ts
  - src/permissions/runtime-bootstrap-provider.ts
  - src/triggers/topic-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Bases agent-first CLI contract

## Intent

`ravi bases` is the local CLI over the Ravi Console Bases API
(`/api/cli/projects/<project>/bases/...`): typed, project-scoped databases with
properties, rows, views, charts, and row-event subscriptions. The OSS side is
transport and plumbing. It sends requests, renders responses, and maps errors.
The Console owns authorization, view policy, filter compilation, validation,
and aggregation.

Bases is backend only. There is no Console UI for Bases. Agents create bases,
properties, views, and charts through this CLI. Every screen over a base
(table, board, form, dashboard, chart, portal) is a Ravi Page the agent
generates and ships with `ravi pages ship --uses <ids>`; the page reads and
writes only through a view, via the `ravi.bases.*` Pages connector actions
(see "Generated Pages"). The `bases` skill documents that workflow.

## Invariants

1. The CLI MUST NOT evaluate view access rules, Query AST filters, or
   authorization. Filters, view specs, chart specs, and access blocks are
   opaque JSON forwarded to the Console. Local parsing is structural only
   (JSON shape, flag syntax, documented limits).
2. Every command MUST accept `--json`. With `--json`, success prints the
   command payload and failure prints the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, ...}}`.
3. Exit codes MUST follow the taxonomy: `0` success, `1` error, `2` usage
   (`PAYLOAD_INVALID`), `3` write brake (`WRITE_REQUIRES_EXECUTE`).
4. Project scope MUST resolve through the Console scope resolver:
   `--project` wins, then the saved Console scope. `--console` MUST match the
   stored credentials, otherwise the command fails with `AUTH_REQUIRED`.
5. Row writes (`rows add`, `rows update`, batch import, `rows
   request-approval|approve|reject`, `rows fill`) and the creates `bases
   create`, `props add`, `views create` and `charts create` MUST send an
   idempotency key both as the `Idempotency-Key` header and as
   `idempotencyKey` in the body. The key is generated per call unless
   `--idempotency-key` overrides it. Keys MUST match
   `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`. The same key and request replay the
   created object; a different request with the key is `CONFLICT`
   (`idempotency_conflict`). Creates carry no `clientHint`. A keyed request
   MUST NOT include a value the CLI read just before (the Console hashes the
   whole request): `props add --idempotency-key` requires
   `--expected-schema-version` (exit 2 before any call), and approval writes
   follow invariant 21.
   Inside an agent session, `rows add` and `rows update` without
   `--idempotency-key` still write, and MUST add `warnings: [string]` to the
   payload (a `warning:` line in human output): a retry would get a new
   generated key and could duplicate the write.
6. Inside an agent session (runtime tool or gateway invocation), row writes
   row archive/restore, `rows fill` and `rows rerun` MUST carry
   `clientHint {agentId?, sessionKey?, sdk}`. The hint is ledger metadata the
   Console records next to the accountable person (`agent` on history
   entries, asserted by the installation) and MUST NOT be sent outside an
   agent session.
6a. Every Console call, reads included, MUST carry the turn's actor
   (`x-ravi-actor-contact`) inside a runtime turn, so a linked person's reads
   and writes act as that person. The Console refuses an unlinked person's
   reads and writes with `ACTOR_NOT_LINKED` (403, which starts the link
   flow); the CLI never retries them as the operator. Inside a runtime turn
   that `resolveAccessActor` refuses (another agent's turn, an unresolved
   speaker) or cannot classify, `openBasesClient` MUST fail `ACTOR_UNKNOWN`
   (exit 3, policy) before any Console call, reads included, instead of
   sending no actor (which the Console would serve as the operator). A run
   of a cron job a contact owns (`owner_principal = contact:<id>` not bound
   to the operator) MUST carry that contact as the actor: the job acts as
   the person who created it through their own `ravi link` (and fails
   `ACTOR_NOT_LINKED` without one), never as the operator who ran
   `ravi login`. A cron job no person owns (`unknown`, an agent) is refused.
   A shell cron the daemon spawned
   (`RAVI_AUTOMATION_PRINCIPAL=automation:cron:<id>`, no context key) counts
   as a runtime turn here, with the same owner rules; shell triggers and
   `ravi jobs run` have no owner model and are not covered. Operator turns,
   owner relays and owner-owned routines act as the operator. Outside a turn
   no actor header is sent.
   When a cron run's contact is not linked, the link flow MUST NOT message
   anyone (nobody is asking in a scheduled run): the refusal carries
   `linkFlow: routine`, no `chatLinePt`, and a suggested action to report
   to the operator, without retrying or disabling the job, that the job's
   creator must link their account.
   The refusal MUST carry a typed reason in `error.refusalReason`:
   `routine_not_operator_owned` (a cron job no person Ravi can act for owns; with
   `jobId` and `ownerPrincipal`), `agent_relay`, `ended` or `unknown`, and a
   `suggestedAction` true for that reason. A routine run has nobody to ask,
   so its action MUST NOT tell the agent to have the person ask from their
   chat: it says not to retry from the run, to report the job to the
   operator without disabling it, and that the operator reviews the job's
   message or command and recreates it from the turn of the person it
   should act for. This copy is
   local: it applies only to the error `openBasesClient` (and the access and
   cloud-run clients) build, marked by its class, never to an
   `ACTOR_UNKNOWN` a Console response carries, which keeps the catalog copy
   whatever its `details` say.
7. `rows update`, `rows archive`, and `rows restore` MUST require exactly one
   of `--expected-version <n>` or `--last-write-wins`, checked before any
   Console call.
8. Base, view, and chart mutations and property mutations MAY omit the
   expected version; the CLI then reads the current version first and sends
   it. The Console still rejects a concurrent change.
9. Errors MUST keep stable codes. Bases adds `NOT_FOUND`, `CONFLICT`, and
   `VERSION_CONFLICT`. A Console HTTP 409 MUST map to `AUTH_PENDING` only on
   `/api/cli/auth` paths (and the OAuth device flow); elsewhere a bare 409 is
   `CONFLICT` and a coded 409 keeps its code. Link aliases
   (`CONFLICT` to `ACTOR_BINDING_CONFLICT`) apply only to `/api/cli/link`.
10. Console `error.details` MUST surface in the CLI envelope:
    `details.error` as `consoleError`, `details.current` as `current` (the row
    at its current version on `VERSION_CONFLICT`), `details.fieldErrors` as
    `issues` with path `["values", <key>]`, plus `requestId` when present.
11. `PROJECT_ACCESS_DENIED` and `ORG_ACCESS_DENIED` MUST list the Bases scopes
    the stored login lacks (`missingScopes`) and suggest `ravi login` again
    when `console.bases.read` or `console.bases.write` is missing.
12. `rows query --all` and `views query --all` MUST follow cursors without
    changing the request between pages and MUST stop after the page that
    reaches `--max-rows` (default 10000). The payload reports `truncated` and
    a `nextCommand` that continues from the last cursor.
13. `rows import` MUST read the base schema, map CSV columns to property keys
    (`--map "Column=key"`, `"Column=-"` skips), fail with `PAYLOAD_INVALID`
    on cells that do not fit their type BEFORE the brake, and dry-run unless
    `--execute`. Batches (at most 500 rows) are sent in order; batch `i` uses
    the key `ravi-import:<sha256(file, project, base, mapping)>:<i>`, so the
    same command replays finished batches instead of duplicating rows.
14. CSV output (`--format csv`, `rows export`) MUST neutralize spreadsheet
    formulas in free-text cells with a leading `'`; import strips it again.
15. `bases subscribe` creates a Console subscription for this installation,
    with the optional filter `--view`, `--props` (1-20) and `--events` (from
    `row.created|updated|archived|restored`, `approval.requested|decided`,
    `agent.requested|backfill`), checked locally before any call and sent as
    `{viewId?, properties?, events?}`. Events then arrive through the existing
    inbox bridge on `ravi.console.inbox.item` with `category: "bases"`. The OSS
    runner MUST NOT add a NATS subject for Bases; it MAY only add
    `payload.row` and `payload.rowEnrichment` (read with the installation
    credential) to `bases.row.*`, `bases.approval.*` and
    `bases.agent.requested` items, never to `bases.rows.bulk_changed` or
    `bases.agent.backfill`.
15a. `bases subscribe --trigger --agent <id> [--session] [--message]` MUST
    check the agent and session before any Console call, then create (or
    reuse, for the same topic, filter and agent) a local trigger on
    `ravi.console.inbox.item` filtered on `data.category == "bases"`, the base
    id, `data.payload.subscriptionId` for a filtered subscription (or the
    absence of one for an unfiltered subscription, so one item wakes one
    trigger) and the event types, sorted (the Console sorts a filter's
    events, so any `--events` order reuses the same trigger). With a `row.*`
    event the types also include `bases.rows.bulk_changed`, and with
    `agent.requested` also `bases.agent.backfill`, because a bulk write sends
    those to such a subscription instead of per-row items. From an agent turn
    (`hasRuntimeInvocationContext`) the trigger MUST be created disabled and
    the output MUST name `ravi triggers enable <id>`; from the operator's
    terminal it is enabled. JSON output includes `trigger {id, enabled, draft,
    filter, enableCommand}`.
16. CLI output (help text, plan `effect`, `suggestedAction`, messages) and the
    `bases` skill MUST NOT send people to a Console UI for Bases. Destructive
    plans name the generated Pages and charts that stop working.
17. The `bases` and `pages` skills MUST tell agents to ship generated pages with `--uses` listing
    the `ravi.bases.*` ids that page's own route calls (the host allows the
    union of the `uses` of its active routes, so a ship of another route never
    removes them), to ship data pages only with `pages ship` (`pages publish`
    and `artifacts publish` declare no `uses` for that route), and MUST NOT
    tell pages to embed row data, tokens, or Console API calls. When an agent adds a `page_viewer` principal, the skill
    MUST tell it to say which host gains which access to which view.
    The data-page guide lives in the `pages` skill
    (`ravi skills show pages --file references/data-pages.md`);
    `bases/references/pages.md` is only a pointer to it.
18. The default skill gate `bases` (`/^bases(?:[._]|$)/` → `ravi-system-bases`)
    MUST load the skill for `ravi bases …` and every `bases.*` subgroup and
    tool. Any identity that can run a `bases` command (`admin:system:*`,
    `execute:group:bases`, `read|mutate:bases[.<sub>]:<action>`) MUST also be
    able to read the skill.
19. `bases views bind <base> <view> <widget-ref|none> [--field k=col ...]
    [--variant <v>]` MUST read the view, then PATCH the full current layout
    (the Console replaces it wholesale) with only `layout.widget` changed, at
    the version it read. The widget is `{ref}` (or `{itemId}` for a UUID)
    plus `fields` and `variant` when given; `none` sends `null`. A layout
    other than board, list, gallery or calendar MUST fail `PAYLOAD_INVALID`
    (exit 2) without a write; malformed or duplicate `--field`, and
    `--field`/`--variant` with `none`, fail before any Console call. The
    Console checks the widget, the mapped columns and the variant. Access is
    `mutate:bases.views:update`, like `views update`.
20. `bases views share <base> <view> --site <slug|id|hostname> [--write a,b]
    [--create] [--archive] [--write-only]` MUST read the full view (a caller
    without manage fails `PROJECT_ACCESS_DENIED` without a write), resolve the
    site from the project's Pages sites (unknown: `NOT_FOUND`), add
    `{kind: "page_viewer", siteId}` to `access.read` (not with
    `--write-only`, which needs a write grant) and, with a write grant, to
    `access.write.principals`, merging columns and flags without removing any,
    then PATCH `access` at the version it read. Widening access is an
    authority escalation: without `--execute` it MUST dry-run (exit 3) with a
    plan of the view, the site (id and host), the grants and the disclosure,
    after reading the view and site (so an unknown site or a caller without
    manage still fails with exit 1). Nothing changed: no PATCH, no brake and
    `changed: false`. The payload and human output MUST carry the disclosure:
    which host gains which access to which view, and that the write block is
    shared by every write principal. Access is `mutate:bases.views:update`
    (risk high, confirmation required).
21. Approvals: `props add --type approval` takes `--approvers`
    (`role:<viewer|developer|project_admin>` or `user:<id>`, 1-20) and
    `--reset-on`. `rows request-approval` writes `"pending"`; `rows approve`
    and `rows reject` write `{state, note?}` and MUST dry-run (exit 3) without
    `--execute` (risk high, no default grant). All three take `--note` (at most
    1000 chars), `--view` and `--expected-version`. Without
    `--expected-version` the write sends `lastWriteWins: true` and MUST NOT
    send a version it read: the Console hashes `expectedVersion` into the
    keyed request, so a read-derived version would turn a retry after a lost
    response into `idempotency_conflict` instead of a replay. The approve and
    reject dry-runs MUST read the row first (an unknown row fails with exit 1,
    not 3) and plan its current version; the plan MUST NOT copy the note
    (only `{present, length}`). The Console decides who may approve; `approval_forbidden` maps to
    `PROJECT_ACCESS_DENIED` with that reason in the envelope.
22. Agent columns: `props add --type agent` takes `--instructions` (1-4000),
    `--inputs` (1-20 keys), `--output`
    (`text|number|checkbox|select|multi_select|url|date`, select outputs need
    `--options`) and `--agent` (a label). `rows fill <base> <row> <prop>
    --inputs-hash <16 hex> (--value <v> | --error <msg>)` posts to
    `.../rows/<row>/agent/<prop>` with an idempotency key; `--value` is JSON
    when it parses, otherwise text. `agent_stale` maps to `CONFLICT` and
    surfaces the current `inputsHash`; its `suggestedAction` MUST say to
    re-read the row, recompute from its current inputs and fill with the hash
    read, never to store the old result under the new hash. `rows rerun` posts to
    `.../agent/<prop>/rerun`.
23. The runtime bootstrap floor MUST grant exactly the Bases reads through
    views and charts: `read:bases:list|show`,
    `read:bases.views:list|show|query`, `read:bases.charts:list|show|data`.
    Direct row reads (`bases.rows:query`, `bases:aggregate`) and every Bases
    write stay opt-in.

## Write classification

| op | class | brake |
|---|---|---|
| `bases archive`, `bases restore` | base becomes read-only/hidden or writable again | local dry-run + `--execute` |
| `bases rows purge` | hard delete of a row and its ledger, irreversible | local dry-run + `--execute` |
| `bases views archive` | charts and generated Pages (forms included) using the view stop working | local dry-run + `--execute` |
| `bases charts archive` | generated Pages that render the chart stop working | local dry-run + `--execute` |
| `bases props update` (type or includeTime change) | data migration | Console dry-run report; `--execute` sends `confirm: true` |
| `bases props delete` | soft delete with dependents | Console dry-run report; `--execute` sends `confirm: true` |
| `bases rows import` | bulk create | local plan after schema read; `--execute` |
| `bases rows approve`, `bases rows reject` | a decision others act on | local dry-run + `--execute` |
| `bases views share` (when it changes access) | a Pages host gains read or write access to the view | local dry-run + `--execute` |
| `bases subscribe --trigger` | local automation | none; from an agent turn the trigger is created disabled |
| `bases create/update`, `props add/restore`, `rows add/update/archive/restore/request-approval/fill/rerun`, `views create/update/bind`, `charts create/update`, `subscribe/unsubscribe` | reversible or versioned writes | none |

## Commands

- `ravi bases list|show|create|update|archive|restore|aggregate|subscribe|unsubscribe|subscriptions`
- `ravi bases props list|add|update|delete|restore`
- `ravi bases rows query|get|add|update|archive|restore|purge|history|import|export|request-approval|approve|reject|fill|rerun`
- `ravi bases views list|show|create|update|bind|share|archive|query`
- `ravi bases charts list|show|create|update|archive|data`

`list` commands use offset pagination (`--limit`, `--offset`, `--fields`);
row queries and history use cursor pagination (`--limit`, `--cursor`).

## Generated Pages

The UI path is a generated Ravi Page. The OSS side only documents the public
connector contract; admission, view policy, and redaction stay in the Console
(`.ravi/specs/console/pages/connectors/SPEC.md` in the Console repo). All
actions are revision 1, take strict input, and act through a view that grants
`{kind: "page_viewer", siteId}` for the page's site:

| id | input | output |
|---|---|---|
| `ravi.bases.views.describe` | `{viewId}` | `{id, baseId, name, description, layout, version, columns, capabilities, valid}` |
| `ravi.bases.views.query` | `{viewId, filter?, sort?, limit?, cursor?}` | `{columns, rows, nextCursor, users}` |
| `ravi.bases.views.version` | `{viewId}` | `{fingerprint}` |
| `ravi.bases.views.rows.get` | `{viewId, rowId}` | `{rowId, version, values, body?, users}` |
| `ravi.bases.views.rows.create` | `{viewId, values, body?, idempotencyKey}` | `{rowId, version}` |
| `ravi.bases.views.rows.update` | `{viewId, rowId, values, body?, expectedVersion, idempotencyKey}` | row `{rowId, version, values, body?}` |
| `ravi.bases.views.rows.archive` | `{viewId, rowId, expectedVersion}` | `{rowId, version}` |
| `ravi.bases.charts.data` | `{chartId}` | `{chart, groups, fields, suppressedGroups, users}` |

- The page calls same-origin `POST /_ravi/connectors/exec` with `{id, input}`
  and gets `{ok: true, id, revision, output}` or `{error}`. `validation_failed`
  may carry `fieldErrors`; `version_conflict` may carry `current`. A viewer
  the view admits only to write gets `{rowId, version, values: {}}` from
  `rows.update` and in `current`.
- `ravi.bases.*` is never implicitly allowlisted: an id no active route of
  the host declared fails with `connector_not_allowlisted`.
- `charts.data` returns the groups as `groups`; the CLI `bases charts data`
  returns the same groups as `data`.
- Pages callers never manage a base. `project_role` and `user` principals do
  not admit on Pages; `page_viewer` admits only on Pages.

## Official error cases

| case | code | exit |
|---|---|---|
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + `plan` | 3 |
| bad flag value, bad JSON, CSV type mismatch, missing concurrency choice | `PAYLOAD_INVALID` | 2 |
| Console validation (`validation_failed`, `invalid_filter`, `unknown_property`, ...) | `PAYLOAD_INVALID` + `consoleError` | 2 |
| unknown base, row, view, or chart | `NOT_FOUND` | 1 |
| stale `--expected-version` | `VERSION_CONFLICT` + `current` | 1 |
| slug/key taken, idempotency or schema-version conflict | `CONFLICT` + `consoleError` | 1 |
| no Bases scope or no access | `PROJECT_ACCESS_DENIED` (+ `missingScopes`) | 1 |
| decision by someone who is not an approver | `PROJECT_ACCESS_DENIED` + `consoleError: approval_forbidden` | 1 |
| `rows fill` with a stale `--inputs-hash` | `CONFLICT` + `consoleError: agent_stale` + `inputsHash` | 1 |
| no credentials or `--console` mismatch | `AUTH_REQUIRED` | 1 |

## Validation

- `bun test src/bases/ src/cli/commands/bases.test.ts` green.
- `bun test src/inbox/ src/permissions/runtime-bootstrap-provider.test.ts src/triggers/__tests__/topic-catalog.test.ts src/triggers/__tests__/runner-filter.test.ts` green.
- `bun test src/cloud-auth/ src/cli/commands/link.test.ts` green (409 mapping).
- `bun test src/cli/confirmation-policy.test.ts src/cli/commands/json-coverage.test.ts src/cli/commands/pagination-coverage.test.ts src/sdk/client-codegen/return-schema-coverage.test.ts` green.
- `make quality` clean.

## Known Failure Modes

- An older login lacks `console.bases.read`/`console.bases.write`; every call
  fails with `PROJECT_ACCESS_DENIED` until `ravi login` runs again.
- A cursor is bound to its query. Changing `--filter` or `--sort` while
  passing `--cursor` fails with `cursor_invalid`.
- `--sort` and `--group-by` take one comma-separated value
  (`--sort prazo,horas:desc`, `--group-by status,prazo:month`). A placeholder
  ending in `...` after a non-word character made the gateway schema an array
  while commander passed a string, so both flags failed from agent sessions.
- Re-running an import with a different `--batch` reuses keys with other
  bodies; the Console answers `CONFLICT` (`idempotency_conflict`) instead of
  creating duplicates.
- A generated page shows `not_found` while `views query` works from the CLI:
  the view does not grant `page_viewer` for that site (CLI callers are admitted
  by `project_role`/`user`, pages only by `page_viewer`).
- Before Console #44 the Pages `uses` allowlist was the last ship's list for
  the whole host, and skills taught shipping the union of every route's ids.
  The host now allows the union over its active routes; a page republished
  with `pages publish` loses only its own route's ids.
- A `--trigger` created from an agent turn stays disabled until the operator
  runs `ravi triggers enable <id>`; the subscription itself is active, so
  items land in `ravi inbox items` meanwhile.
- The trigger `--trigger` creates does not filter `data.actor.type`. An agent
  that writes the same base must add that condition (`ravi triggers set <id>
  filter ...`) or subscribe only to events its writes do not produce.
