# Self Transport Bridge / WHY

Agents orient themselves with `ravi self`. If that output led with raw
transport data (a WhatsApp JID or LID, a Slack channel id, an Omni payload),
agents would build on ids that change per transport, per account and per
migration, and would skip the Ravi records that carry routing, policy and
identity.

WhatsApp moved from Omni to the `ravi channels` runner without changing chat,
contact or session identity. The same rule covers every transport: the
transport is provenance, and Ravi semantic records come first. Keeping the
projection behind adapter/service boundaries is what made that migration
invisible to `ravi self`.

Missing records are shown as gaps instead of being filled with raw ids, so an
agent knows when to run a diagnostic instead of trusting a guess.
