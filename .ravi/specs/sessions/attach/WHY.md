# Session Attach / WHY

`sessions/attach` lets one session keep a shared history across multiple chats.
The important boundary is the current turn: a reply belongs to the chat or
thread that produced that turn.

The default attachment exists only for proactive turns with no inbound chat.
This keeps the normal experience automatic and prevents a later message from
redirecting work that is already running.
