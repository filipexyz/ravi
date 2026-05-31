---
id: sync/console-bridge
title: "Console Sync Bridge Checks"
kind: checks
domain: sync
capability: console-bridge
owners:
  - ravi-dev
status: draft
normative: true
---

# Checks

- Bridge uses cloud-auth client helpers.
- Uploads include idempotency keys.
- Downloads are cursor-based.
- Missing handlers keep events inspectable.
- Failed sync does not fail daemon startup unless explicitly configured as
  required.
- Logs omit bearer tokens and payload secrets.
