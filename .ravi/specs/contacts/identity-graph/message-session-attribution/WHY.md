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

## Why Canonicalize Instance References

Identity lookup keys on `channel + instance_id + normalized_platform_user_id`, so the
`instance_id` a channel sends must match the one used when the identity was stored. In
practice a channel can reference the same instance by more than one value over time — for
example a logical account slug versus a configured legacy instance UUID. Exact-only lookup
against the received value then misses a known actor, marks it unresolved, and authorization
correctly grants zero capabilities: a false permission denial that is expensive to diagnose.

Canonicalizing the instance reference from explicit configuration keeps the identity key
stable across those aliases without loosening it. It is deliberately not a fuzzy or
cross-instance search: aliases come only from configuration for the same instance, the empty
legacy scope stays exact rather than a wildcard, and another workspace is never consulted.
That preserves the "raw ids are provenance, trusted mappings are identity" principle — the
slug↔UUID mapping is a trusted mapping, not weak evidence.

Because attribution drives authorization, an ambiguous alias (equivalent references pointing
at different owners) must not silently pick a winner. Failing closed with an explicit reason,
distinct from a plain not-found, keeps the wrong principal from inheriting a turn's authority.

## Tradeoff

This adds more nullable columns and more writes on the inbound/outbound path.

The cost is acceptable because it prevents identity bugs that are expensive to debug later: wrong contact timelines, wrong permission checks, incorrect outbound targeting, and agents refining the wrong person's context.
