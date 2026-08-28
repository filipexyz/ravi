# Session Attach / WHY

`sessions/attach` lets one session keep a shared history across multiple chats.
The important boundary is the current turn: a reply belongs to the chat or
thread that produced that turn.

The default attachment exists only for proactive turns with no inbound chat.
This keeps the normal experience automatic and prevents a later message from
redirecting work that is already running.

CLI-only `sessions send` is a first-class destination: the waiting CLI reads
this turn's transcript. HTTP / app session-relay send is the same kind of
session destination for emit: leftover `lastChannel` and the default output
attachment must not become WhatsApp/Slack. Attach stays fail-closed for
chat delivery. Persist + `sessions.read` remain the sink.

The `[session surface]` line tells the model where a normal reply returns.
That instruction is model-visible on every new logical turn, including
operator CLI-only and HTTP `sessions.send`.

The operator user row is different: `sessions read`, chat display, and
transcript must show only what the user typed. Gluing "waiting CLI" or
"no inbound chat" into that row leaks host routing into the displayed
history. Two payloads, one turn: runtime prompt carries the header;
persisted `user.text` stays raw. WhatsApp/Slack inbound can keep the
header on the stored prompt because the channel already shows the
original message.
