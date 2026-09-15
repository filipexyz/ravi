# Chat Model / WHY

Ravi needs a canonical chat model because a channel conversation and an agent
runtime session are different things. The same WhatsApp group, DM, room, or
thread can host multiple Ravi agent sessions, each with its own state.

Keeping chat, participant, actor, and session data separate prevents group chats
from being modeled as people, keeps prompt participant lists scoped to the chat
they describe, and preserves raw Omni ids only as provenance.

Session attach lives on `session_chat_subscriptions`, not on a second 1:1
binding table. A chat may host many historical sessions, but only one active
subscription may own it.
