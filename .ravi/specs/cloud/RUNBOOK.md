---
id: cloud
title: Ravi Cloud Runbook
kind: runbook
domain: cloud
status: draft
normative: false
owners:
  - ravi-dev
---

# Ravi Cloud Runbook

## Check The Login

```bash
ravi whoami --json
ravi cloud key status --json
```

A missing or expired login fails every `ravi cloud` command with
`AUTH_REQUIRED`; run `ravi login` again.
