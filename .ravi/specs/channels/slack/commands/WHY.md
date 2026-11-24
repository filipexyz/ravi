# Why

Before this feature a Slack slash command reached the runner, was acked and then
ignored: the person who typed it saw nothing. The controls Ravi already has
(`sessions threads`, `sessions close-thread`, `sessions runtime interrupt`)
lived only in the terminal and in the agent's tools, so the operator had to ask
an agent, and pay a turn, to close a thread or stop one.

A command is control, so it skips the agent. It runs in the daemon, on the
contact's own authority, through the same permission providers and the same
operations the CLI uses. That is also why it asks the CLI's two questions: an
agent calling `sessions close-thread` needs the command's capability and the
right over the session, and a person typing the same words must not need less.

Slack constrains the shape. A slash command must be acked within three seconds,
so the runner acks first and answers later through the `response_url`, which
Slack accepts five times and for thirty minutes. The command payload carries no
thread, and Slack does not run an app's command inside a thread, so commands
act on the DM or channel session; controls for one thread are buttons on the
thread card and message shortcuts in the "..." menu of its messages.

A shortcut that changes something asks first. The tap is one gesture in a menu
next to many harmless ones, and a stray one must not close a thread or stop a
turn. The question is a private card in the thread and not a modal on purpose: a
modal has to be opened within three seconds of the tap, by something that holds
a Slack Web client with the right to open views, and today only the runner does,
while the engine, the authority and the audit are in the daemon, which reaches
Slack for message sends only. A private card in the thread is the path approval
cards already use, has no three-second window, and keeps the answer where the
person is looking: a shortcut's own response handle posts at channel level.
The card carries the time it was asked so a confirmation left on screen is not an
order for later.

Socket Mode has no request signature, so "verify the origin" cannot mean a
signature. What can still be wrong is whose command it is: a distributed app
receives every installed workspace's commands on one socket, so the workspace is
checked against the instance's own bot, and the app is pinned for the
connection.

"Idle" is read from the runtime. The health label of a thread is a sample taken every so often, and the lifecycle date does not move when a parent sends a thread new instructions, so a thread restarted a minute ago can look a day old. The command reads the runtime's own records, thread by thread, right before closing it, and counts every open thread instead of the newest page.

Commands are never replayed. They are not stored in the durable inbox, and the
daemon refuses one older than a minute, because a `stop` typed ten minutes ago
must not run after a restart.

Slash command names are not namespaced: two apps in one workspace that register
the same name collide, and Slack runs the one installed most recently. The name
is therefore set on each Slack app (`/ravi`, `/hana`) and Ravi answers under the
name that was typed.

The words are English by the operator's decision.
