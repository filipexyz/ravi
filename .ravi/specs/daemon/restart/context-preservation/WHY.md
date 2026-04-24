# Restart Context Preservation / WHY

## Rationale

Restart is disruptive and usually initiated from a live conversation. The user expects the acknowledgement to return to the same conversation after the daemon comes back.

The context must be captured automatically because requiring a manual notify target creates avoidable operator error.

## Tradeoffs

- Keeping `-m` required preserves restart provenance.
- Removing forced/scheduled restart semantics makes restart behavior predictable.
- The child restart process can run without runtime context, so it must not destroy metadata captured by the parent.
