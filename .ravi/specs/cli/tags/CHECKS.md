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
- `tags doctor` MUST leave `tag_definitions`, `tag_bindings` and `tag_events`
  row counts unchanged (`src/tags/doctor.test.ts`, "never writes").
- `tags doctor` MUST list a definition with no current binding, count a
  binding to a missing agent as orphan (and a session bound by key as not
  orphan), keep tags read by a tag rule (apply or condition, any spelling),
  by the permission provider (any `permission.*` spelling) or by a chat-tag
  grant scope out of "without consumer", flag a contact whose tags (registry
  or policy only) materialize `admin:system:*` as break-glass, and apply
  `--limit` to every list section. Each rule is pinned by a mutation that
  makes `src/tags/doctor.test.ts` fail.
- `tags doctor --limit 0` MUST exit 2 with `USAGE_ERROR`.
- `tags doctor` called with only `read:tags` MUST return `power: "withheld"`,
  empty `powerTags` and `chatGrantPower`, `null` power counts and no contact
  id from those sections; with `admin:system:*` it MUST return them
  (`src/cli/commands/tags.test.ts`, "shows who holds power only to a caller
  with admin:system:*"). Withheld sections MUST NOT be computed
  (`src/tags/doctor.test.ts`, "withholds both power sections").
- `tags doctor` MUST list a chat-scoped grant whose profile carries
  capabilities, skip one that carries none, and count an admin profile name
  as break-glass (`src/tags/doctor.test.ts`, "lists chat-scoped grants").
- `bun test src/cli/commands/tags.test.ts` SHOULD pass after any change to the
  tags contract surface.
