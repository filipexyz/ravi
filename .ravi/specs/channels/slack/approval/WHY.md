# Why

Native Slack approval previously waited on `ravi.inbound.reaction`, but that
path never resolved reliably for Socket Mode workspaces and required reaction
Event Subscriptions. Operators also needed a grantor gate: anyone who could
see the message could approve.

Block Kit buttons reuse the existing Slack delivery and
`ravi.inbound.interaction` stack. The pending request record is the source of
truth. Button values are correlation handles only. The same `canWithCapabilities`
materializer that already turns contact permission tags into grant authority
decides who may approve, on Slack and WhatsApp.
