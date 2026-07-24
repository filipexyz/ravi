---
id: channels/slack/operations
title: "Slack Operations"
kind: feature
domain: channels
capability: slack
feature: operations
capabilities:
  - slack
  - permissions
tags:
  - slack
  - tools
  - workspace-management
  - credentials
applies_to:
  - src/channels/slack/
  - src/cli/commands/slack.ts
  - src/permissions/
owners:
  - dev
status: active
normative: true
---

# Slack Operations

## Intent

Slack workspace operations are first-class Ravi capabilities.

Ravi SHOULD expose Slack features as typed native operations instead of leaking raw Slack tokens or requiring agents to call the Slack Web API directly.

## Initial Operation Surface

The first native surface MUST include:

- `slack.channels.list`
- `slack.channels.info`
- `slack.channels.history`
- `slack.members.list`
- `slack.files.list`
- `slack.permissions.list`
- `slack.messages.send`
- `slack.blocks.validate`
- `slack.blocks.send`
- `slack.blocks.update`
- `slack.blocks.showcase`
- `slack.channels.create`
- `slack.channels.rename`
- `slack.channels.invite`
- `slack.topology`

Slack custom sidebar sections are not part of the initial native operation surface.

Ravi MUST NOT present Slack `usergroups.*` as "sections". User groups are not equivalent to the operator's Slack sidebar sections, and bot-token custom sidebar access is not available in the current implementation.

## Invariants

- Slack credentials MUST be resolved through the Ravi credential broker unless explicit local env fallback is enabled.
- Slack credentials MUST NOT be printed, logged or returned in JSON payloads.
- Read operations MUST return structured JSON suitable for agents.
- List operations MUST expose pagination metadata.
- Permission read operations MUST expose granted OAuth scopes without exposing token values.
- Mutating operations MUST default to dry-run.
- Mutating operations MUST require an explicit execution flag before calling Slack.
- Channel invite operations MUST accept explicit Slack user IDs and MUST NOT infer users from display names.
- Message send operations MUST support explicit channel IDs and optional thread timestamps.
- Block Kit message operations MUST validate payload shape locally and MUST keep `text` as top-level fallback.
- Block Kit interactions MUST be published as `ravi.inbound.interaction`, not routed as ordinary chat prompts.
- Each operation MUST declare command access metadata with resource, action and risk.
- Agents MUST receive permission to the Ravi operation, not to the raw Slack token.
- CLI commands running in a Slack-sourced runtime SHOULD default to the source Slack account when no connection is passed.
- Topology operations MUST focus on Slack channels, Ravi routes, Ravi sessions and inbound policy gates.
- Unsupported or high-risk Slack admin operations MUST be added behind separate specs and permission gates.

## Boundary

This feature owns direct Slack workspace/operator commands under `ravi slack`
and their dry-run contract. Context-bound message actions discovered through a
runtime session are owned by `channels/slack/chat-actions`; invoking those
commands is already an explicit execution request.

The Slack Web API client owns low-level HTTP calls and Slack response normalization.

The CLI/tool layer owns:

- choosing the credential connection;
- enforcing dry-run defaults;
- exposing command access metadata;
- formatting JSON output for agents;
- avoiding token leakage.

The permission provider owns whether a given agent/user may execute a Slack operation.

## Native Skill Direction

Slack-related Ravi skills MUST target this native Slack operation surface for channel creation, channel reads, membership management, files, permissions and topology.

Omni-backed Slack behavior is legacy bridge behavior during migration and MUST NOT be the default target for new Slack skills.

The future channel-creation skill MUST include the OAuth scope bundle required by these native operations, including read, write, invite, file, reaction and channel management scopes.
