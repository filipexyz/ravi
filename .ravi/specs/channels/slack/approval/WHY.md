# Why

Native Slack approval previously waited on `ravi.inbound.reaction`, but that
path never resolved reliably for Socket Mode workspaces and required reaction
Event Subscriptions. Operators also needed a grantor gate: anyone who could
see the message could approve.

Block Kit buttons reuse the existing Slack delivery and
`ravi.inbound.interaction` stack. The pending request record is the source of
truth. Button values are correlation handles only. The same contact-policy
materializer plus capability snapshot matcher that already turns permission
tags into grant authority decides who may approve, on Slack and WhatsApp.

Public cards still failed in practice (bug 5acbe4f7, Slack channel of a
customer session): everyone in the channel saw Approve, a person without the
permission clicked it, and the click was ignored without a word. The request
expired, and on Pi, whose permission hooks are serialized, every later tool
call queued behind it. Even an approved shell command was refused, because the
Bash check of delegated turns read only the agent's live ceiling. So the card
now goes privately to the people who can grant it (ephemeral in the chat, or
their DM), a request nobody can grant fails at once, every click is answered,
an approval is honored by the Bash check, and the tool's inactivity window
covers the wait.
