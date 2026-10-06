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
5. Row writes (`rows add`, `rows update`, batch import) MUST send an
   idempotency key both as the `Idempotency-Key` header and as
   `idempotencyKey` in the body. The key is generated per call unless
   `--idempotency-key` overrides it. Keys MUST match
   `^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$`.
6. Inside an agent session (runtime tool or gateway invocation), row writes
   and row archive/restore MUST carry `clientHint {agentId?, sessionKey?, sdk}`.
   The hint is untrusted ledger metadata and MUST NOT be sent outside an
   agent session.
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
15. `bases subscribe` creates a Console subscription for this installation.
    Row events then arrive through the existing inbox bridge on
    `ravi.console.inbox.item` with `category: "bases"`. The OSS runner MUST
    forward the item unchanged and MUST NOT add a NATS subject for Bases.

## Write classification

| op | class | brake |
|---|---|---|
| `bases archive`, `bases restore` | base becomes read-only/hidden or writable again | local dry-run + `--execute` |
| `bases rows purge` | hard delete of a row and its ledger, irreversible | local dry-run + `--execute` |
| `bases views archive` | charts, forms, and Pages using the view stop working | local dry-run + `--execute` |
| `bases charts archive` | Console and Pages stop rendering the chart | local dry-run + `--execute` |
| `bases props update` (type or includeTime change) | data migration | Console dry-run report; `--execute` sends `confirm: true` |
| `bases props delete` | soft delete with dependents | Console dry-run report; `--execute` sends `confirm: true` |
| `bases rows import` | bulk create | local plan after schema read; `--execute` |
| `bases create/update`, `props add/restore`, `rows add/update/archive/restore`, `views create/update`, `charts create/update`, `subscribe/unsubscribe` | reversible or versioned writes | none |

## Commands

- `ravi bases list|show|create|update|archive|restore|aggregate|subscribe|unsubscribe|subscriptions`
- `ravi bases props list|add|update|delete|restore`
- `ravi bases rows query|get|add|update|archive|restore|purge|history|import|export`
- `ravi bases views list|show|create|update|archive|query`
- `ravi bases charts list|show|create|update|archive|data`

`list` commands use offset pagination (`--limit`, `--offset`, `--fields`);
row queries and history use cursor pagination (`--limit`, `--cursor`).

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
| no credentials or `--console` mismatch | `AUTH_REQUIRED` | 1 |

## Validation

- `bun test src/bases/ src/cli/commands/bases.test.ts` green.
- `bun test src/cloud-auth/ src/cli/commands/link.test.ts` green (409 mapping).
- `bun test src/cli/confirmation-policy.test.ts src/cli/commands/json-coverage.test.ts src/cli/commands/pagination-coverage.test.ts src/sdk/client-codegen/return-schema-coverage.test.ts` green.
- `make quality` clean.

## Known Failure Modes

- An older login lacks `console.bases.read`/`console.bases.write`; every call
  fails with `PROJECT_ACCESS_DENIED` until `ravi login` runs again.
- A cursor is bound to its query. Changing `--filter` or `--sort` while
  passing `--cursor` fails with `cursor_invalid`.
- Re-running an import with a different `--batch` reuses keys with other
  bodies; the Console answers `CONFLICT` (`idempotency_conflict`) instead of
  creating duplicates.
