# Contacts agent-first CLI contract / WHY

Contacts are the gate between the outside world and the bot. `remove` deletes
the canonical record and `merge` collapses two identities and deletes the
source, so those two keep the write brake. `block` is a reversible containment
action (`allow` is its inverse) and delaying it can prolong unwanted traffic,
so it runs immediately. The rest of the surface (`add`, `allow`, `approve`, `set`,
`tag`/`untag`, `link`/`unlink`, `note`, `metadata set/remove`) stays immediate:
each is either additive or has an obvious inverse, and braking the intake loop
would put exit-3 friction inside every approval flow. `backfill` already
shipped with its own default-dry-run flag (`--apply`); renaming it to
`--execute` would break existing automations for zero safety gain, so it is
documented as the brake equivalent instead.

Suggestions ARE included on `CONTACT_NOT_FOUND`, unlike `cli/sessions` which
omits them. The sessions concern — scope cloaks unauthorized entities as
not-found, and suggesting real names would defeat the cloak — applies to
contacts too (`contactScope` own/tagged), but contacts have what sessions
lacked: a ready caller-scope filter, `filterVisibleContacts`, the exact filter
behind `contacts list`/`find`. Candidates drawn from that list only ever name
contacts the caller could already enumerate, so the cloak holds and the
envelope stays actionable.

Implementation findings from this wave:

- The service layer throws `Contact not found: <ref>` (`addContactNote`,
  `setContactMetadata`, `linkContactIdentity`, ...) while the command layer
  wraps bodies in `try/catch { fail(err.message) }`. That catch would also
  swallow `ContractError` thrown by pre-checks inside the try. The
  `rethrowContactCommandError` helper does both jobs: rethrows contract errors
  untouched and maps the service's not-found message onto the envelope — the
  tasks-style wrapper adapted to catch-based command bodies.
- Two ops reported not-found as success: `get` returned `found:false` (exit 0)
  and `remove` returned a soft `not_found` payload. Both were converted to the
  hard `CONTACT_NOT_FOUND` envelope — an agent branching on exit codes never
  saw those soft paths, and `remove` needed the resolve-first step anyway so
  the dry-run plan could show the real target.
- `contacts.test.ts` mocks `../context.js` WITH a spread of the real module, so
  `hasContext` silently resolved to the real env-dependent implementation —
  tests would pass or `process.exit` depending on `RAVI_*` envs in the shell.
  The mock now pins `hasContext: () => true` explicitly.

Parser-level usage errors (unknown flag, missing argument) are exercised in
`crm.test.ts` against a real commander tree; `contacts.test.ts` mocks the
decorator layer, so per-domain tests cover the command-body contract and the
shared parser behavior is validated once in the crm suite.
