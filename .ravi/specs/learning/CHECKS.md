---
id: learning
title: "Learning Loop Checks"
kind: domain
domain: learning
status: draft
---

# Learning Loop Checks

## Spec Checks

```bash
ravi specs get learning --mode full --json
ravi specs sync --json
```

## Review Checklist

- Is the learning durable outside the current chat?
- Is the chosen surface correct?
- Is provenance recorded?
- Is there a validation or regression check when code changed?
- Would another agent know when to apply this learning?
- Is anything sensitive excluded from durable shared surfaces?

## Anti-Clutter Checks

- A new skill without a trigger is invalid.
- A new routine without a silence policy is invalid.
- A new spec without a MUST/SHOULD-level rule is probably a note, not a spec.
- A memory without a subject/person/project is probably an insight instead.
