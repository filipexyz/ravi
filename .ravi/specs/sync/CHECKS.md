---
id: sync
title: "Local-First Sync Checks"
kind: checks
domain: sync
owners:
  - ravi-dev
status: draft
normative: true
---

# Checks

- Local commands work without remote credentials.
- Syncable domain writes create local events or can be mapped to events.
- Outbox retries are idempotent.
- Inbox application is idempotent.
- Local-only data is not uploaded.
- Remote-owned data is not mutated by local sync except through explicit public
  APIs.
- Conflict policy exists before enabling a domain for bidirectional sync.
