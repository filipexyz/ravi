# Why Slack Chat Actions Are Separate

Slack workspace operations and conversational actions have different targets
and safety contracts. Workspace operations are explicit operator commands with
dry-run. Chat actions are tied to the current session, chat and message.

Using the generic Omni gateway for a native Slack account caused missing
instance errors and silent reaction drops. Native mappings keep Slack credentials,
scopes, message timestamps and provider failures inside the Slack adapter.

Thread creation crosses two ownership domains: Slack owns posting the native
root, while the daemon owns sessions and runtime prompts. A durable delivery
handoff between them avoids creating a child for a Slack message that never
existed and keeps session work out of the channel runner.
