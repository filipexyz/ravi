# Why Channel Messages Exist

`ChannelMessage` is the canonical record that lets Ravi reason about inbound, outbound and system messages across platforms.

Ravi cannot let Slack, WhatsApp or Omni-specific payloads become the semantic model. Platform data is preserved, but canonical behavior must be expressed through Ravi message fields.

This model also gives delivery, presence, reactions, media and routing a shared identity surface.
