# Chat Model / RUNBOOK

## Debug Flow

1. Read the active rules:
   `ravi specs get channels/chats --mode rules --json`.
2. For an inbound event, identify `sourceChat`, `outputChat`, session key, agent
   id, actor type, contact id, agent id, platform identity id, and raw provider
   provenance.
3. Verify the chat is keyed by channel, instance, and normalized chat id. Do not
   treat a session name or raw group id as the canonical chat.
4. Inspect `chat_participants` for canonical membership. Use
   `session_participants` only as runtime participation evidence.
5. In prompt context, ensure participants are nested under `sourceChat` or
   `outputChat`, with safe display labels only.

## Triage

- If a group appears as a contact, route the fix through the chat/contact
  migration boundary.
- If output goes to the wrong surface, inspect `session_chat_subscriptions`
  (active chats and the default output) before changing transport delivery.
  Do not look for `session_chat_bindings`.
