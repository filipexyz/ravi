# Tag-rules agent-first CLI contract / CHECKS

## Checks

- `tag-rules show <unknown-id> --json` MUST exit 1 with the
  `TAG_RULE_NOT_FOUND` envelope and up to three `suggestions` of real rule
  ids from the already-loaded registry.
- `tag-rules evaluate <unknown-id> --target contact:<id> --json` MUST exit 1
  with the same `TAG_RULE_NOT_FOUND` envelope.
- `tag-rules explain --target contact:<unknown>` and `tag-rules evaluate
  <rule> --target contact:<unknown>` MUST exit 1 with `CONTACT_NOT_FOUND` and
  MUST NOT carry suggestions (contact visibility is scoped inside the
  contacts domain).
- `tag-rules tick --json` and `tag-rules evaluate <rule> --target ... --json`
  WITHOUT `--apply` MUST NOT write any tag: the contacts DB read back after
  the run MUST be unchanged.
- The same invocation WITH `--apply` MUST perform the write; `--apply` is the
  documented brake equivalent and MUST NOT be renamed to `--execute`.
- `tag-rules list --fields id,scope --json` MUST return rules containing only
  the requested fields.
- `tick` and `evaluate` MUST declare `CommandAccess.kind: "mutate"`; a
  read-only capability MUST be denied before the handler and an exact mutate
  capability allowed.
- A `ContractError` thrown with `RAVI_*` envs present MUST preserve its exit
  code through the registry dispatcher.
- `bun test src/cli/commands/tag-rules.test.ts` SHOULD pass after any change
  to the tag-rules contract surface.
