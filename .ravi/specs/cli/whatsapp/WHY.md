# WhatsApp agent-first CLI contract / WHY

This is the CLI domain with the highest EXTERNAL risk: every mutation acts on
real WhatsApp groups and real people. A stray `group remove` is publicly
visible and socially irreversible; a stray `group send` cannot be unsent; a
`group leave` announces itself to every member. The write-brake benchmark that
motivated the contract showed exactly this class of failure (0/27 unintended
writes blocked before the brake, 27/27 after), so here the brake covers the
ENTIRE mutation surface — 12 group ops plus `dm send` — instead of only the
"destructive" subset used in calmer domains like tasks.

Decisions that shaped this wave:

- **Braking beyond the declared metadata.** `group join`, `leave`,
  `description` and `settings` are declared `kind: "read", risk: "low"` in
  their CommandAccess metadata, but each one mutates live group state that
  every member sees. The brake follows the RUNTIME behavior, not the legacy
  metadata. The metadata itself was left untouched: `access.kind` is consumed
  by the permission layer (`enforceCliCommandAuthorization` uses it as the
  permission name), so flipping read→mutate would silently change
  authorization outcomes for existing agents — a permission-model change that
  does not belong in a contract migration. Reported instead.
- **Unbraked ops are the ones with no new external content.** `group list`,
  `group info` and `group invite` only read. `dm ack` (and the implicit ack in
  `dm read`) sends blue ticks — it confirms reading but produces no content
  addressed to the peer, and braking it would add exit-3 friction to every
  read loop; `dm read --no-ack` already exists for silent reading.
- **Suggestions only from sources already in hand.** `GROUP_NOT_FOUND` in
  `group info` enriches the envelope from the group list that the resolution
  path had ALREADY fetched (omni REST with local chat-model fallback) — zero
  extra provider calls; when even that list is empty the envelope simply
  carries `suggestedAction: ravi whatsapp group list --json`. Contact
  suggestions (`CONTACT_NOT_FOUND` in group create/add and dm send/read/ack)
  come from `searchContacts`, the local SQLite contacts DB — a cheap local
  source. No suggestion path ever makes a live bridge call of its own.
- **Validation stays ahead of the brake.** Unknown participants, an unknown
  routed agent (`group create --agent ghost` without `--create-agent`) and an
  invalid `settings` value all fail with their own error before the dry-run,
  so an exit-3 plan is always an executable plan.
- **`group create` brakes before its LOCAL side effects too.** The command is
  transactional (omni group + agent creation + chat/route/session
  registration); the brake sits before `ensureGroupAgent`, otherwise a
  dry-run with `--create-agent` would still create agents and directories.

Parser-level usage errors use the global exit-2 `USAGE_ERROR` envelope with
`acceptedFlags`; command-body errors preserve the same shared taxonomy.
