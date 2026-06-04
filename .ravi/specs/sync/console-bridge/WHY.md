---
id: sync/console-bridge
title: "Why Console Sync Bridge"
kind: why
domain: sync
capability: console-bridge
owners:
  - ravi-dev
status: draft
normative: true
---

# Why

The bridge keeps the OSS/Console boundary clean. OSS owns local persistence and
transport. Console owns product policy, authorization, and cloud projections.

Using the existing cloud auth client prevents a second token lifecycle from
appearing in the codebase.

Cursor-based HTTP keeps the first implementation simple and compatible with
local-first offline behavior. Realtime push can be added later without changing
the domain event model.
