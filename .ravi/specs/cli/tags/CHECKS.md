# Tags agent-first CLI contract / CHECKS

## Checks

- `tags show <unknown-slug> --json` MUST exit 1 with the `TAG_NOT_FOUND`
  envelope and up to three `suggestions` built from real slugs/labels.
- `tags set <unknown-slug> label X --json` MUST map the DB throw
  (`dbUpdateTagDefinition`) to the same `TAG_NOT_FOUND` envelope, exit 1.
- `tags attach <unknown-slug> --contact <id> --json` MUST exit 1 with
  `TAG_NOT_FOUND` and MUST NOT write any binding.
- `tags detach <unknown-slug> ...` MUST exit 1 with `TAG_NOT_FOUND`; when the
  tag exists but the binding does not, the declared legacy text
  (`Binding not found ...`, exit 1) SHOULD be kept until a binding envelope is
  specified.
- `tags list --fields slug,kind --json` and `tags search --fields tagSlug
  --json` MUST return items containing only the requested fields.
- No `tags` op is braked: `create`, `set`, `attach` and `detach` MUST keep
  immediate-write behavior, and any future destructive op (e.g. `tags rm`)
  MUST ship with the dry-run + `--execute` brake.
- A `ContractError` thrown with `RAVI_*` envs present MUST preserve its exit
  code through the registry dispatcher.
- `bun test src/cli/commands/tags.test.ts` SHOULD pass after any change to the
  tags contract surface.
