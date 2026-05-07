# Why Message And Session Identity Attribution

## Decision

Messages and sessions should carry structured identity attribution whenever Ravi has enough evidence to resolve it.

The attribution belongs on message/event metadata and participant models. Sessions remain runtime containers. Chats remain conversation containers. Contacts and agent-owned platform identities remain the canonical actor model.

## Rationale

Future Ravi agents need to understand a person across chats, routes, projects, and sessions. That is not possible if the system must reconstruct identity from raw WhatsApp ids, group ids, display names, or session names.

The same user can appear through:

- a phone JID
- a WhatsApp LID
- a Telegram account
- an email address
- a group sender id
- a DM
- a shared support or project session

Those appearances should converge through `platform_identity -> contact` when evidence is strong enough.

## Why Not Session-As-Identity

Sessions are agent runtime state. They can be created, restarted, renamed, routed, or duplicated for the same chat.

Using a session as the identity source fails when:

- a group contains multiple people
- multiple agents share a chat
- one person talks across multiple channels
- one chat has multiple workflows
- a session contains system events and human messages

Session metadata can cache helpful context, but identity-sensitive behavior must use actor metadata and participants.

## Why Not Message Text Or Display Name

Prompt text and display names are weak evidence.

They are useful for UI and diagnostics, but they can be duplicated, spoofed, stale, or omitted. Automatic attribution must rely on provider ids, trusted mappings, explicit links, or operator-confirmed merges.

Weak evidence should create candidates or proposals, not merged identities.

## Tradeoff

This adds more nullable columns and more writes on the inbound/outbound path.

The cost is acceptable because it prevents identity bugs that are expensive to debug later: wrong contact timelines, wrong permission checks, incorrect outbound targeting, and agents refining the wrong person's context.
