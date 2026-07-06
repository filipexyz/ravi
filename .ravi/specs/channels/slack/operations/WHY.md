# Why Slack Operations Are Native Ravi Capabilities

Slack has enough workspace surface area that treating it as only message delivery leaves value on the table.

Agents need to inspect channels, files, members and history, and operators need controlled ways to create or rename channels. These actions should not require ad hoc scripts or raw token exposure.

The Ravi-native shape gives us:

- credential isolation through the broker;
- operation-level permission checks;
- audit-friendly command metadata;
- dry-run defaults for mutations;
- shared code that can later back CLI, SDK, UI and agent tools.

## Rejected Alternatives

- Give agents raw Slack tokens. This breaks credential boundaries and audit.
- Add one generic `slack.api` tool. This is flexible but bypasses typed permission and risk metadata.
- Implement only UI actions. Agents and automation need the same capabilities through CLI/SDK.
