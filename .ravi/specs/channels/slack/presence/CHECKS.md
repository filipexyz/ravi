---
id: channels/slack/presence/checks
title: "Slack Native Presence Checks"
kind: checks
domain: channels
capability: slack
feature: presence
status: active
normative: true
---

# Slack Native Presence Checks

- `SlackWebApiClient.setAssistantThreadStatus` MUST post to `assistant.threads.setStatus` with `channel_id`, `thread_ts` and `status`.
- Active native presence MUST send a non-empty status.
- Inactive native presence MUST send an empty status.
- Native presence MUST prefer `target.threadId` and fall back to `target.sourceMessageId`.
- Reaction fallback MUST run when native status errors.
- Reaction cleanup MUST run on inactive fallback mode even if native status succeeds.
- Reaction cleanup MUST attempt `reactions.remove` even when local active state was lost.
- The Slack native runner MUST default to assistant status enabled and reaction fallback mode.
