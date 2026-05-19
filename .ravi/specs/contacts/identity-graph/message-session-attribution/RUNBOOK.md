# Message And Session Identity Attribution Runbook

## Before Implementation

Read the required identity/contact/channel specs:

```bash
bin/ravi specs get channels --mode rules --json
bin/ravi specs get channels/chats --mode rules --json
bin/ravi specs get contacts --mode rules --json
bin/ravi specs get contacts/identity-graph --mode rules --json
bin/ravi specs get contacts/identity-graph/unified-model --mode rules --json
bin/ravi specs get contacts/identity-graph/message-session-attribution --mode rules --json
bin/ravi specs get contacts/timeline --mode rules --json
```

Inspect current actor/session/message persistence:

```bash
rg -n "message_metadata|session_events|session_participants|chat_participants|actor_type|contact_id|agent_id|platform_identity_id|identity_provenance" src
```

Inspect current inbound/outbound source ids:

```bash
rg -n "raw_sender|senderPhone|resolvedSenderPhone|chatJid|source_chat_id|source_message_id|last_to|group_id|session_key" src/omni src/router src/gateway.ts src/session-trace
```

## Implementation Order

1. Add typed helpers for actor attribution from raw inbound/outbound facts.
2. Add or extend persistence columns for actor metadata on message metadata and session events.
3. Normalize/upsert chat and sender platform identity before route/session policy decisions.
4. Upsert `chat_participants` from provider participant facts when available.
5. Upsert `session_participants` from observed runtime activity.
6. Record outbound actor metadata for agent/system senders and explicit targets.
7. Update contact interaction projections only through resolved contact actors/targets.
8. Add contact timeline links for meaningful message/session-derived context.
9. Add permissions/redaction around broad actor metadata reads and trigger streams.

## Debugging Wrong Attribution

When a message or session is attributed to the wrong identity:

1. Start with the raw event: channel, account, raw sender id, chat id, message id, and timestamp.
2. Check normalization: raw sender id to normalized sender id.
3. Resolve `platform_identity` by `channel + instance_id + normalized_platform_user_id`.
4. Check owner: contact, agent, or unresolved.
5. Check whether the chat target was accidentally treated as the speaker.
6. Check `chat_participants` for canonical membership.
7. Check `session_participants` for observed runtime participation.
8. Check message/session actor fields before inspecting prompt text or session names.

## Backfill

Existing records may be backfilled when raw provenance is sufficient:

- set `actor_type='unknown'` when only raw ids exist
- set `platform_identity_id` when a unique identity can be resolved
- set `contact_id` or `agent_id` only when identity evidence is strong
- preserve raw provider ids even after canonical ids are filled

Backfills MUST NOT infer a contact from display name alone.

## Operator-Facing Checks

Useful commands after implementation:

```bash
ravi contacts get <contact-or-platform-id> --json
ravi contacts timeline <contact> --json
ravi sessions trace <session-key> --json
ravi specs get contacts/identity-graph/message-session-attribution --mode checks --json
```

Session traces should show the resolved actor when available and raw provenance when unresolved.
