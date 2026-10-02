# Mentioned Contact Context / WHY

When a group message mentions someone, the agent often needs to know who that
person is to read the message correctly. Without help it either queries the
CRM on every turn or guesses from the display name.

Resolving the formal mention through the identity graph gives a reliable
answer, and attaching it as structured runtime context keeps it out of the
visible prompt. Framing it as data, not as an event, prevents two failures:
agents treating CRM values as instructions, and agents waking up to answer
just because someone was mentioned.

The context is per message and advisory, so it never widens what the agent
may reveal or access.
