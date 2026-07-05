---
id: channels/runner
title: "Channel Runner"
kind: capability
domain: channels
capabilities:
  - runner
  - lifecycle
tags:
  - process
  - pm2
status: active
normative: true
---

# Channel Runner

## Responsabilidade

`ravi channels` MUST own native channel adapters, platform sockets/webhooks, outbound delivery, media and presence lifecycle.

`ravi daemon` MUST own sessions, agents and runtime. It MUST NOT open Slack Socket Mode connections or resolve Slack transport credentials.

## Outbound

User-visible native channel delivery MUST cross `CHANNEL_OUTBOUND` before adapter delivery.

The stream MUST be durable enough to survive a temporary `ravi channels` restart.

## Lifecycle

The runner MUST expose:

- `ravi channels start`
- `ravi channels stop`
- `ravi channels restart`
- `ravi channels status`
- `ravi channels logs`
- `ravi channels run`
- `ravi channels probe`

## Locks

Adapters SHOULD use process or credential-scoped locks before opening external sockets. Slack MUST prevent duplicate Socket Mode consumers for the same connection.

