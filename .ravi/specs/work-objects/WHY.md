# Why Work Objects

Slack Work Objects are the first visible consumer, but the capability is broader
than Slack. Ravi needs a stable domain adapter layer so the same entity previews,
details, edits, and actions can be reused by Slack, dashboards, automations, and
other agents.

The chosen design keeps the domain service inside Ravi and keeps channel-specific
rendering outside the domain:

- Ravi knows tasks, artifacts, pages, sessions, workflows, and permissions.
- Omni knows channels and how to render channel capabilities.
- Slack knows Work Object UI events and metadata format.

This prevents a Slack-only implementation from leaking into task logic and avoids
duplicating domain mutations in every future integration.

