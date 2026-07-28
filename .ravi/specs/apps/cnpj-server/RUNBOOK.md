# CNPJ Server / RUNBOOK

## Discover And Validate

```bash
ravi apps show cnpj-server --json
ravi apps check cnpj-server --json
ravi cnpj --help
```

## Check Connectivity

```bash
ravi cnpj health \
  --base-url http://100.77.169.127:8090 --json
```

## Read One Company

```bash
ravi cnpj get 00.000.000/0001-91 \
  --base-url http://100.77.169.127:8090 --json
```

## Search One Bounded Page

```bash
ravi cnpj search --uf SP --cnae 1340500 --limit 10 \
  --base-url http://100.77.169.127:8090 --json
```

When `pagination.hasMore` is true, execute the returned `nextCommand`. Do not
replace it with auto-pagination or an unbounded export.

## Preview CRM Export

```bash
ravi cnpj export-crm --uf SP --owner agent:main --limit 20 \
  --base-url http://100.77.169.127:8090 --json
```

Review `candidates`, `dedupe`, and `selectionHash`. Applying is a separate
medium-risk CRM write requiring `writeContacts`; copy the returned
`nextCommand` exactly. Never replace its pinned CNPJ list with filters.

After an authorized apply, recover imported leads with:

```bash
ravi crm accounts --source cnpj-server --lifecycle lead \
  --owner agent:main --limit 50 --offset 0 --json
```

## Recover From Errors

- `INVALID_ENDPOINT`: use the exact Tailscale URL shown by the command.
- `INVALID_CNPJ` or `INVALID_SEARCH`: correct the input; do not retry unchanged.
- `NOT_FOUND`: stop or use `search`.
- `TIMEOUT`, `TRANSPORT_ERROR`, `UPSTREAM_UNAVAILABLE`: confirm tailnet health,
  then manually retry the same read.
- `INVALID_RESPONSE`: stop and investigate contract drift.
