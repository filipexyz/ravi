# Channels config agent-first CLI contract / CHECKS

## Checks

- `channels show <unknown-name> --json` MUST exit 1 with the
  `CHANNEL_NOT_FOUND` envelope and up to three `suggestions` from local
  channel config names.
- `channels set <unknown-name> <key> <value>` MUST exit 1 with
  `CHANNEL_NOT_FOUND` and MUST NOT create or modify any config row.
- `channels create <name> --credential-connection <unknown>` and
  `channels set <name> credentialConnection <unknown>` MUST exit 1 with the
  `CREDENTIAL_CONNECTION_NOT_FOUND` envelope (id-only suggestions, no secret
  material) and MUST NOT write the channel config.
- `channels create` and `channels set` are declared unbraked and MUST keep
  immediate-write behavior for valid inputs (no `--execute` requirement).
- `channels list --fields a,b,c --json` MUST return items containing only the
  requested fields (both `channels` and `items` keys).
- The infra ops (`start`, `stop`, `restart`, `run`, `logs`, `probe`,
  `status`) MUST keep their pre-existing behavior — they are outside this
  contract per the migration ledger's dispensa.
- The shipped `channels` skill MUST document this contract (migrated config
  ops + the infra dispensa) in its `## Contrato Do CLI` section.
- `bun test src/cli/commands/channels.test.ts` SHOULD pass after any change to
  this contract surface, with zero new failures vs the 13-test baseline.
