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
- After the owner tag is removed, the next turn MUST be back under the agent's
  ceiling.
- The Bash hook MUST allow an owner-authority turn's command outside the
  agent's list and MUST still refuse it when the snapshot lacks it
  (hook.test.ts, "bounds an owner-authority turn by its issued snapshot").
