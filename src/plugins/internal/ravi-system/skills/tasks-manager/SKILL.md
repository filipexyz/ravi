---
name: tasks-manager
description: |
  DEPRECATED. Compatibility alias for old TASK.md-first task handling.
  Use `ravi-system-tasks` for all current Ravi task runtime work.
---

# Deprecated: Tasks Manager

This skill is a managed compatibility alias for `ravi-system-tasks`.

Use `ravi-system-tasks` for profile-aware task work. Do not dispatch new work to
`ravi-system-tasks-manager`.

Removal target: when compatibility is no longer needed, delete this source alias
and run:

```bash
ravi skills sync --json
```
