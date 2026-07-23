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

## Adapter Health

The runner MUST derive each adapter's live status from the adapter lifecycle,
not from process existence or from having invoked `start()` successfully.

For each configured Slack account, runner status MUST:

- remain starting/connecting until the active Socket Mode connection is
  actually healthy;
- transition through connected and reconnecting as the socket heartbeat and
  recovery loop changes state;
- retain non-secret transition reasons and lifecycle/health timestamps;
- recover independently from the state of other Slack accounts; and
- transition to disconnected during explicit runner shutdown without allowing
  retired adapter callbacks to restore an online state.

A PM2 process reported as online MUST NOT, by itself, be treated as proof that a
Slack adapter is connected.

Live status MUST scope its health request to the PM2 runner PID. If that PID
changes while the request is in flight, status MUST refresh the PM2 snapshot
and retry once against the replacement process instead of reporting the stale
PID as current.

## Locks

Adapters SHOULD use process or credential-scoped locks before opening external sockets. Slack MUST prevent duplicate Socket Mode consumers for the same connection.
