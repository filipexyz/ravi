---
id: channels/slack/presence/why
title: "Why Slack Native Presence"
kind: why
domain: channels
capability: slack
feature: presence
status: active
normative: true
---

# Why Slack Native Presence

Slack already exposes a native assistant working state. Ravi should use that state instead of encoding "agent is working" primarily as an emoji reaction.

The old reaction-only behavior has two operational problems:

- reactions are not lifecycle-managed by Slack and can stay visible after daemon restarts or missed terminal events;
- reactions are a message annotation, not Slack's first-class app activity surface.

`assistant.threads.setStatus` gives Ravi a native status that Slack can expire automatically and that Ravi can also clear explicitly. Reactions remain useful as compatibility fallback while workspaces, scopes and Slack UI behavior are being validated.
