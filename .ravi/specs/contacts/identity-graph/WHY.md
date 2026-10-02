# Contact Identity Graph / WHY

One person reaches Ravi through several identifiers: a phone number, a
WhatsApp phone JID and LID, a Telegram id, an email. Treating each identifier
as its own contact splits history, policy and CRM data, and treating a
display name as identity merges people who are not the same.

The graph keeps the identifier (`platform_identity`) separate from the actor
that owns it (`contact` or `agent`). Groups stay chats, agents stay in the
agent registry, and sessions reference actors without becoming the source of
truth for them.

Automatic links need strong evidence, such as the transport's LID-to-phone
mapping, because a wrong merge leaks one person's context into another's.
Weak evidence only produces candidates, and every merge or unlink is audited
so it can be reviewed and reversed.
