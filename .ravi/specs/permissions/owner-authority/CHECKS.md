# Owner Authority / CHECKS

## Checks

- An owner-tagged contact speaking in a group of an agent with a closed list
  of executables MUST get `execute:executable:<anything>` and
  `ownerAuthority: contact:<id>` (runtime-request-context.test.ts, "acts with
  the owner's own authority").
- A plain contact in the same group MUST stay at the agent's list.
- A relay of the owner's turn MUST carry owner authority; a relay of the plain
  contact's turn MUST NOT.
- An owner narrowed by a chat `deny_*` MUST NOT get owner authority, and a
  relay of that turn MUST NOT either ("an admin narrowed by a grant in that
  chat keeps the overlay").
- Full access granted only in a chat MUST NOT give owner authority.
- A contact with global `permission-admin` (or superadmin) MUST stay at the
  agent's list, and a relay of their turn MUST NOT carry owner authority.
- After the owner tag is removed, the next turn MUST be back under the agent's
  ceiling.
- The Bash hook MUST allow an owner-authority turn's command outside the
  agent's list and MUST still refuse it when the snapshot lacks it
  (hook.test.ts, "bounds an owner-authority turn by its issued snapshot").
- An agent `deny_*` unrelated to the command MUST NOT remove the owner's
  shell access ("an agent deny does not cut the owner").
- A relay from a person credential of the owner (paired device, call) MUST NOT
  carry owner authority (person-credential.test.ts).
- A queued relay of the owner's turn MUST lose owner authority once a chat
  `deny_*` narrows the owner in the producing turn's chat.
- An owner-authority turn MUST carry `RAVI_TURN_OWNER_AUTHORITY=1` and the next
  ordinary turn MUST NOT; Codex MUST open the owner's turn unrestricted for a
  restricted agent profile and keep a bridge turn restricted
  (codex-provider.test.ts, `resolveCodexTurnSecurity`).
