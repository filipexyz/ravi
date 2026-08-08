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

- **Authorization follows the effect.** `group join`, `leave`, `description`,
  `settings` and `dm read` are `mutate` because they can change live WhatsApp
  state. Exact legacy grants are migrated so least-privilege callers do not
  lose their prior command-level access.
- **Confirmation follows the invocation.** `group list`, `group info` and
  `group invite` only read. `dm read --no-ack` is also a local read and stays
  immediate. A blue-tick receipt is still an observable outbound signal, so
  the implicit receipt in `dm read` and explicit `dm ack` require confirmation
  before NATS emission. This avoids taxing silent read loops.
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

Confirmation requires knowing the target kind and material effect, not a phone,
JID suffix, display name, group subject, invite, or message body. Counts,
presence flags, and text lengths preserve enough intent for an agent to decide
whether to execute without copying personal data into the public plan.
