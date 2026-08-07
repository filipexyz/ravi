# Chats agent-first CLI contract / WHY

Chats are the surface agents use to read conversations and to drive reading
queues (`chats.lists`): observers, CRM enrichment, and human-review flows all
consume it. Almost everything here is a read or a reversible cursor/config
write, so braking broadly would put exit-3 friction inside every reading loop
for no safety gain. `chats lists remove` only stamps `removed_at` on the local
membership, retains cursor history, and is reversed by `lists add`; it therefore
runs immediately while remaining a `mutate` operation.

Two ops already had their own dry-run discipline before this wave and were
deliberately NOT renamed to `--execute`:

- `chats backfill-provider-timestamps` runs as a dry-run unless `--apply` is
  passed — same semantics as the brake, established earlier. Renaming the flag
  would break existing callers for zero contract gain; the spec documents it as
  an equivalent.
- `chats lists recompute` pairs with `chats lists preview` (read-only diff) and
  a selector safety gate that blocks unsafe selectors (e.g. `match:any` with
  negative conditions) before any write. The preview command IS its dry-run.

Suggestion scoping followed the contacts-wave lesson: chats and reading lists
are admin-scoped and fully enumerable via their own `list` ops, so not-found
suggestions built from those same local listings reveal nothing new. Contacts
are different — they enforce `contactScope` inside the contacts domain, and
chats has no cheap way to reproduce `filterVisibleContacts` here — so
`CONTACT_NOT_FOUND` carries no suggestions and points to the scoped listing
instead of guessing.

One structural finding: `resolveReadingList`'s fallback lookup lives inside a
try/catch that re-fails every caught error. The contract's not-found throw
happens inside that try, so without an explicit `instanceof ContractError`
rethrow the envelope would be flattened back into a legacy `fail()` — the same
class of bug the contacts wave hit with its service-layer wrapper.

There is no dedicated `chats` skill to teach the surface; that gap remains
registered in the SPEC rather than silently ignored.
