# Contacts agent-first CLI contract / CHECKS

## Checks

- `contacts get <unknown-ref> --json` MUST exit 1 with the `CONTACT_NOT_FOUND`
  envelope and up to three `suggestions` of real contacts.
- Every `CONTACT_NOT_FOUND` suggestion MUST come from the caller-scope-filtered
  contact list (`filterVisibleContacts`); a contact cloaked by `contactScope`
  MUST never be suggested.
- An invalid flag on any `contacts` op MUST exit 2 with `acceptedFlags` in the
  envelope.
- `contacts remove` and `contacts merge` without `--execute` MUST exit 3,
  MUST report `dryRun: true` with the `plan`, and MUST NOT delete or merge
  anything; with `--execute` the write MUST happen.
- The `remove` plan MUST be `{contact, namePresent, phonePresent, status}` and
  the `merge` plan MUST be `{source, sourceNamePresent, target,
  targetNamePresent, identitiesToMove}`; neither plan may expose names or
  phone numbers.
- `contacts block` MUST block immediately without `--execute`, remain
  `kind: "mutate"`, and be reversible via `contacts allow`.
- `contacts backfill` MUST stay preview-only without `--apply` and MUST keep
  that historical flag name (no rename to `--execute`).
- A braked op invoked with `RAVI_*` envs present (agent context) MUST still
  exit 3 with the envelope — the registry dispatcher MUST preserve
  `ContractError.exitCode` instead of the generic exit 1.
- `contacts list --fields a,b,c --json` and `contacts find <q> --fields a,b,c
  --json` MUST return items containing only the requested fields.
- Unbraked writes listed in the spec MUST keep immediate-write behavior, and
  the shipped `contacts` skill MUST list them explicitly as unbraked.
- `bun test src/cli/commands/contacts.test.ts` SHOULD pass after any change to
  the contacts contract surface.
