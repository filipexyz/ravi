---
id: cloud
title: Ravi Cloud Checks
kind: checks
domain: cloud
status: draft
normative: false
owners:
  - ravi-dev
---

# Ravi Cloud Checks

- `ravi cloud` commands MUST fail with `AUTH_REQUIRED` (exit 1) without a `ravi login` session.
- No `ravi cloud` command output MUST contain a provider key; only `keyHint`.
- Commands that spend money, create provider objects or send a secret MUST exit 3 without `--execute`.
