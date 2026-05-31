---
id: runtime/cloud-trace-export
title: "Cloud Trace Export Runbook"
kind: runbook
domain: runtime
capability: cloud-trace-export
owners:
  - ravi-dev
status: draft
normative: true
---

# Runbook

## Debug Missing Remote Trace

1. Confirm local trace exists in `session_events` and `session_turns`.
2. Confirm cloud auth is linked.
3. Inspect export queue/outbox row.
4. Retry one event by id.
5. Compare remote response idempotency key.
6. Check remote Data Plane request id.

## Debug Bad Payload

1. Inspect local safe preview.
2. Inspect payload hash.
3. Check redaction result.
4. Do not print full prompt/tool output unless local operator explicitly asks
   and the data is safe.
