# Channel Chat Actions Checks

- [ ] A chat surface alone MUST NOT make every action available.
- [ ] Unsupported actions MUST return a stable unavailable reason.
- [ ] Planned actions MUST NOT expose an executable command.
- [ ] Queue acceptance MUST return `queued`, never provider success.
- [ ] Provider-confirmed synchronous actions MAY return `succeeded`.
- [ ] Native action jobs MUST carry request id, idempotency key and both
      canonical and platform message identity.
- [ ] A failed edit/delete MUST NOT mutate the canonical message.
- [ ] Reusing an idempotency key with different input MUST fail closed.
- [ ] Provider errors MUST be explicit; missing adapter mappings MUST NOT
      become silent no-ops.
- [ ] Command access metadata MUST match action semantics and risk.
