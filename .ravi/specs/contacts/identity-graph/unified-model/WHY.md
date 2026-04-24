# Why Unified Contacts Model

## Decision

Keep `contacts` as the product and CLI surface, but implement it as an identity graph internally.

Do not expose a new top-level `ravi identity` CLI for the MVP.

## Rationale

`contacts` is the language operators already understand. CRMs generally expose people and relationship records as contacts, while raw identifiers such as phone, email, WhatsApp id, and Telegram id are contact points or identities.

Ravi needs the same split:

- `contact` is who the human/operator thinks about.
- `platform_identity` is how that actor appears in a channel.
- `contact_policy` is how Ravi is allowed to interact with that actor.
- `agent` is an internal actor that may also have channel identities.
- `chat` is a conversation context, not a person.

This avoids the current ambiguity where contact records mix identity, approval, routing, policy, and sometimes group/chat semantics.

## Why Not `ravi identity`

`identity` is architecturally correct but too abstract as the primary UX.

Operators want to answer:

- who is this person?
- is this contact allowed?
- which channels do they use?
- why did Ravi route/respond this way?
- are these two records duplicates?

Those are contact questions.

The identity graph should exist in code and specs, but the public command should remain `ravi contacts`.

## Why Agents Are Not Contacts

Agents are internal runtime actors.

If an agent uses a WhatsApp, Telegram, or another active platform account, that account is a platform identity owned by the agent.

Treating agents as normal contacts would pollute CRM semantics and make merges dangerous.

## Why Groups Are Not Contacts

Groups, rooms, and threads are conversation containers.

They may have display names, avatars, participants, and policies, but they are not real-world people.

Group membership should be modeled through chat participants pointing to platform identities.

## Tradeoff

Doing this "all at once" is more invasive, but it is cleaner than slowly extending the current contacts table until it becomes an implicit identity graph with unclear rules.

The safe version of big-bang is:

- write explicit migration
- keep old CLI aliases
- keep compatibility lookups
- add regression tests around routing, inbound, LID mapping, merge, and policy
- never delete legacy data until the new model is validated
