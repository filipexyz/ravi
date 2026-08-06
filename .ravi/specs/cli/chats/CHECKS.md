# Chats agent-first CLI contract / CHECKS

## Checks

- `chats read <unknown-ref> --json` MUST exit 1 with the `CHAT_NOT_FOUND`
  envelope and up to three `suggestions` built from real chats (ids, titles,
  normalized chat ids).
- An unknown reading-list ref on `chats lists` ops MUST exit 1 with the
  `READING_LIST_NOT_FOUND` envelope and up to three `suggestions` from real
  lists, honoring the `--owner` filter when one was passed.
- An unknown `--contact` filter on `chats list --json` MUST exit 1 with
  `CONTACT_NOT_FOUND` and MUST NOT carry suggestions — contacts are visibility-
  scoped in their own domain and the envelope only points to
  `ravi contacts list`.
- `chats lists remove` without `--execute` MUST exit 3, MUST report
  `dryRun: true` with the removal `plan` (list id, list name, chat id), and
  MUST NOT deactivate the membership; with `--execute` the write MUST happen.
- `chats lists remove` MUST resolve (and possibly fail on) the list and chat
  refs BEFORE the brake, so a dry-run of a bad ref exits 1, not 3.
- `chats backfill-provider-timestamps` without `--apply` MUST remain a dry-run
  that writes nothing, and its flag MUST NOT be renamed to `--execute`.
- `chats lists recompute` MUST stay blocked by the selector safety gate for
  unsafe selectors, with `chats lists preview` as its read-only diff; neither
  gains an `--execute` flag.
- `chats list --fields a,b,c --json`, `chats lists list --fields a,b,c --json`,
  and `chats lists members <list> --fields a,b,c --json` MUST return items
  containing only the requested top-level fields.
- Unbraked writes declared in the spec (`ensure`, `messages create`,
  `lists create`, `lists add`, `lists mark-read`, `delta --mark-read`) MUST
  keep immediate-write behavior.
- A `ContractError` thrown inside `resolveReadingList`'s try/catch fallback
  MUST be rethrown untouched (never flattened into a legacy `fail()`).
- `bun test src/cli/commands/chats.test.ts` SHOULD pass after any change to the
  chats contract surface.
