---
id: quality
title: "Runtime Quality Checks"
kind: domain
domain: quality
status: draft
---

# Runtime Quality Checks

## Spec Checks

```bash
ravi specs get quality --mode full --json
ravi specs sync --json
```

## Future CLI Checks

When `ravi quality` exists, it MUST support:

```bash
ravi quality modes list --json
ravi quality scan --since 24h --json
ravi quality issues list --json
ravi quality issues show <id> --json
ravi quality watch list --json
```

## Regression Criteria

- A repeated failure in one time window SHOULD be grouped into one issue.
- A grouped issue MUST preserve per-occurrence references.
- A root-cause packet MUST have evidence, suspected boundary, and validation plan.
- A closed watch window MUST record why it closed.
- A reopened issue MUST point at the prior fix/watch window.
