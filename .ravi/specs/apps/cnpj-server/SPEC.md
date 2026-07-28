---
id: apps/cnpj-server
title: "CNPJ Server"
kind: capability
domain: apps
capability: cnpj-server
capabilities:
  - manifest
  - cli
  - operations
  - health
tags:
  - apps
  - cnpj
  - company-registry
  - tailscale
  - read-only
  - crm
applies_to:
  - src/apps/cnpj-server/
  - src/cli/commands/cnpj.ts
  - src/plugins/internal/ravi-system/skills/cnpj-server/
owners:
  - ravi-dev
status: draft
normative: true
---

# CNPJ Server

## Intent

Expose bounded, typed company-registry reads from the private CNPJ Server and
an explicitly pinned, idempotent export into Ravi CRM.

## Invariants

- The CNPJ Server client MUST remain read-only and MUST NOT issue POST, PUT,
  PATCH, or DELETE requests.
- Every network command MUST require `--base-url` explicitly and MUST accept
  only `http://100.77.169.127:8090`.
- The app MUST NOT fall back to `https://cnpj.sdebot.top`,
  `http://oneplus:8090`, loopback, another tailnet address, or an implicit
  default.
- The app MUST NOT disable TLS verification or offer an insecure flag.
- `get` MUST validate Receita Federal CNPJ check digits before network access.
- `search` MUST require at least one discovery filter and fetch one bounded
  page, with `limit` from 1 to 100. It MUST NOT auto-paginate.
- `export-crm` MUST default to dry-run. Apply MUST require an explicit CNPJ
  list, matching selection hash, owner, `writeContacts` scope, and no discovery
  filters. It MUST NOT create contacts or opportunities or retry writes.
- Automatic retry MUST remain disabled. Errors MUST tell the caller whether a
  manual retry is safe.
- Successful network payloads MUST pass the native Zod response contract before
  the command publishes them.
- The app MUST own no database, files, events, artifacts, credentials, or
  tokens. CRM writes use the existing contacts/CRM model and idempotency keys.
- The existing standalone adapter MUST remain unchanged as a parity baseline.

## Interfaces

- App id: `cnpj-server`
- Static CLI: `ravi cnpj`
- Dynamic router alias: `ravi cnpj-server`
- Manifest: `src/apps/cnpj-server/ravi.app.json`
- Generated SDK/tool namespace: `cnpj`
- Required app permission metadata: `cnpj:read`
- Decorated reads: `cnpj.registry` with `health`, `get`, or `search`
- CRM mutation: `crm.account/export-cnpj`, medium risk, `writeContacts`

## Operations

### `cnpj-server.health`

`ravi cnpj health --base-url <url> --json`

Runs one `GET /api/v1/busca?page=1&limit=1`. Returns readiness, latency,
transport, engine, returned item count, and upstream result count.

### `cnpj-server.get`

`ravi cnpj get <cnpj> --base-url <url> --json`

Runs one `GET /api/v1/cnpj/:cnpj` after normalization and local check-digit
validation. Returns the typed company, establishment, Simples, and partner
records.

### `cnpj-server.search`

`ravi cnpj search [filters] --base-url <url> --json`

Runs one `GET /api/v1/busca`. Supports text, UF, CNAE, city, share-capital
range, company size, opening-date range, page, and limit. Returns typed items
plus bounded page metadata and `nextCommand` when a full page is returned.

### `cnpj-server.export-crm`

`ravi cnpj export-crm [filters] --owner <type:id> --base-url <url> --json`

Dry-run fetches one bounded page, deduplicates by normalized CNPJ and returns
the candidate list, `selectionHash`, and exact pinned `nextCommand`. An empty
candidate page is valid and returns `nextCommand: null`.

`--apply` rejects filters and pagination. It requires `--cnpjs`,
`--selection-hash`, `--origin-filters`, `--owner`, and `writeContacts`.
Each selected company creates or reuses one CRM lead account and one confirmed
CNPJ fact through deterministic idempotency keys. The command never creates a
contact or opportunity and never retries a read or write automatically.

### `ravi crm accounts`

Lists existing `crm_account_cards` with source, lifecycle, owner and
limit/offset filters, including accounts without contacts or opportunities.
The implementation joins the existing view to `crm_accounts` for `source`; it
does not add a table or change the view schema. The command requires
`write_contacts` so a scoped reader cannot use unlinked accounts to bypass CRM
authorization.

## Error Contract

Errors expose:

- `code`: stable machine code;
- `category`: `corrigir`, `retry`, `autorizar`, or `parar`;
- `retryable`: whether the same read may safely be attempted again;
- `message`: redacted diagnosis;
- `nextAction`: concrete operator/agent response.

The app MUST NOT include response bodies, secrets, context keys, or stack traces
in error messages.

## Source Contract

The source artifact is the owner-provided `@sdebot/cnpj-sdk` archive
`0.9.1-beta`, SHA-256
`c34fadf092dbf0b7104f59852ce93604944dbc8746a7e6fabe2b627503448963`.

The existing local vendor is `0.9.0-beta`. Version `0.9.1-beta` adds
`dataInicioMin`, `dataInicioMax`, and `data_inicio_atividade`, and changes its
default host to `http://oneplus:8090`. The app copies neither package and
inherits neither default; it implements the reviewed read contract natively.

The sanitized live `buscar?page=1&limit=1` envelope omits the SDK's declared
`motor` field. The native boundary therefore keeps `engine` optional.

## Validation

- `bun test src/apps/cnpj-server/ src/cli/commands/cnpj.test.ts src/cli/commands/crm.test.ts`
- `bun src/cli/index.ts apps check cnpj-server --json`
- `bun src/cli/index.ts cnpj health --base-url http://100.77.169.127:8090 --json`
- `bun src/cli/index.ts cnpj search --uf SP --limit 1 --base-url http://100.77.169.127:8090 --json`
- `bun src/cli/index.ts cnpj export-crm --uf SP --owner agent:main --limit 1 --base-url http://100.77.169.127:8090 --json`
- `RAVI_STATE_DIR=<isolated> bun test src/apps/cnpj-server/crm-export.test.ts`
- `bun run gen:commands`
- `bun run sdk:generate`
- `bun run sdk:check`
- `bun run typecheck`
- `bun run build`

## Known Failure Modes

- Off-tailnet hosts cannot reach the private IP: return a typed transport error
  and do not choose another endpoint.
- An upstream 404 for `get` is a non-retryable domain result.
- An upstream 429, 5xx, or timeout is caller-retryable, but the app performs no
  hidden retry loop.
- A malformed or drifted JSON response fails before publication.
- A CRM apply may be partial. The receipt identifies each failed CNPJ; the
  caller MUST reconcile that item and MUST NOT replay the full batch blindly.
- Live validation MUST stop at dry-run. `--apply` is tested only with an
  isolated `RAVI_STATE_DIR` in this phase.
