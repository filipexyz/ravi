# CNPJ Server / CHECKS

## Static Contract

- The manifest is discoverable; CNPJ reads have no mutation, and the sole
  `export-crm` mutation requires `write_contacts`. The app owns no storage,
  event, artifact, token, or credential.
- All four native commands have `@CommandAccess`, `@Returns`, `--json`,
  `--base-url`, bounded inputs, and complete help. The three CNPJ operations
  are low-risk reads; CRM export is medium-risk and scoped `writeContacts`.
- Endpoint validation rejects the public hostname, `oneplus`, loopback, HTTPS,
  credentials, paths, queries, and fragments before fetch.
- Invalid CNPJ/search inputs fail before fetch.
- 404, 429, 5xx, timeout, transport, and malformed-response errors are typed.
- Provider failures result in one request; there is no automatic retry.

## Commands

```bash
bun test src/apps/cnpj-server/ src/cli/commands/cnpj.test.ts src/cli/commands/crm.test.ts
bun src/cli/index.ts apps check cnpj-server --json
bun run gen:commands
bun run sdk:generate
bun run sdk:check
bun run typecheck
bun run build
```

## Controlled Live Reads

Run only on an authorized tailnet-connected host:

```bash
bun src/cli/index.ts cnpj health \
  --base-url http://100.77.169.127:8090 --json
bun src/cli/index.ts cnpj search --uf SP --limit 1 \
  --base-url http://100.77.169.127:8090 --json
bun src/cli/index.ts cnpj export-crm --uf SP --owner agent:main --limit 1 \
  --base-url http://100.77.169.127:8090 --json
```

Expected: all three commands issue one GET and return typed JSON. `export-crm`
remains dry-run without `--apply`. They perform no CRM write, deployment,
restart, credential mutation, or legacy cutover.
