---
id: watch/connectors
title: "Watch Connectors"
kind: capability
domain: watch
capability: connectors
capabilities:
  - npm
  - github
tags:
  - watch
  - connectors
applies_to:
  - src/watch
  - src/cli/commands/watch.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Watch Connectors

## Intent

Connectors are reusable watch implementations. A connector defines how to
configure a source, where it can run, what event types it emits, and how events
are deduped.

## Connector Contract

Each connector MUST declare:

- `id`
- human label and description
- supported placements: `local`, `console`, or both
- required and optional configuration fields
- credential requirements and credential storage boundary
- supported event types
- polling or webhook behavior
- dedupe key rules
- payload redaction rules

Connectors MUST emit the domain-level watch event contract from `watch/SPEC.md`.

## Placement Capability

- `local` means the connector can run in the local daemon or foreground debug
  command without Console execution.
- `console` means the connector can run remotely and deliver events through
  inbox.
- Connectors MAY support both. `auto` selection SHOULD choose local when it is
  reliable and credential-safe, otherwise Console.

## Credential Boundary

Connector records MUST NOT store raw provider secrets.

Local connectors MAY refer to local credential names, environment variables, or
Ravi credential handles. Console connectors MAY refer to Console-managed
installation ids or provider account ids.

## Acceptance Criteria

- A new connector can be added without changing trigger runner semantics.
- The CLI can list connector event types and placement support.
- The same configured watch can move placement without changing trigger topics
  or payload semantics.
