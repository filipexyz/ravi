# Permission Provider Runtime / WHY

## Rationale

The previous relation-backed grant implementation was embedded as Ravi's native
permission model. That makes every protected surface depend on relation-graph
semantics even when the domain needs a different policy model.

The desired architecture is a provider runtime:

- Ravi core is policy-agnostic.
- Providers own policy.
- Local grants, if needed, are only one provider.
- Apps can ship app-owned providers.
- Future policy engines can replace or compose with local grant behavior without
  changing every runtime and CLI call site.

This is a cleaner boundary than "native grant graph plus app provider hook"
because it prevents a relation graph from remaining the hidden source of truth.

## Decisions

- Make the Permission Provider Runtime the only authorization API.
- Treat relation-backed grants as one provider implementation, not a required
  core model.
- Allow deleting old relation-backed behavior once replacement providers cover required
  surfaces.
- Keep a minimal core bootstrap layer for identity, provider registry,
  sandboxing, redaction, timeout, composition, and audit.
- Move grant/approval application into provider-owned administration, not core
  relation storage.
- Keep migration behind the facade, then provider implementations, with no
  separate old engine surface.

## Rejected Alternatives

- **Keep a native grant graph as core guardrail.** Rejected because it preserves
  the coupling we are trying to remove.
- **Let apps call arbitrary policy code directly.** Rejected because it bypasses
  audit, timeout, redaction, and composition.
- **Delete relation-backed authorization before a provider facade exists.** Rejected because current
  authorization call sites are broad and deleting first would break runtime,
  CLI, SDK gateway, bash hooks, approvals, context issuance, calendar, mailbox,
  apps, and tests without a replacement authorization facade. Deleting it after
  the facade exists is allowed.
- **Make provider allow override all denies.** Rejected because provider
  composition must be explicit; hidden overrides are privilege escalation.

## Migration Direction

1. Introduce `PermissionProviderRuntime` facade.
2. Keep current relation-backed behavior only as `local-grants`, or replace it
   behind the facade.
3. Move all call sites to the facade.
4. Add domain providers for apps/calendar/mailbox/etc.
5. Disable or delete `local-grants` when replacement coverage is complete.
6. Remove old specs/docs that describe relation grants as core.
