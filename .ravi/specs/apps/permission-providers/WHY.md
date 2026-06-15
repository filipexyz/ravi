# App Permission Providers / WHY

## Rationale

The old relation graph was used as Ravi's native permission model. That made the
platform depend on one policy implementation and forced every app-domain rule to
either become a relation tuple or bypass the central permission model.

Calendar, mail, CRM, tasks, artifacts, and future apps all need different
domain rules:

- owner-only resources;
- shared resources;
- delegated resources;
- team/workspace membership;
- workflow state;
- provider-synced external ACLs;
- app-local privacy and retention rules.

Encoding all of that as global relation tuples makes the permission graph too
large, too broad, and too hard to clean safely. It also couples app evolution to
core permission migrations.

App Permission Providers split the problem inside a single provider runtime:

- Ravi core resolves identity/context and runs providers.
- Platform providers decide platform authority.
- Each app enforces its own resource semantics through a typed, bounded,
  auditable decision hook.

That gives us a smaller core and a more pluggable app ecosystem.

## Decisions

- Do not keep relation grants as the native outer boundary. Any equivalent of
  `use app:<id>` and `execute app:<id>` must be decided by a configured provider.
- Provider decisions are pure decisions. They do not mutate another provider's
  policy state. This preserves provider ownership for grants, revocation,
  temporary lifetime, and audit.
- `needs_grant` is a denial with a suggestion, not an approval. This keeps
  approval UX separate from authorization.
- Providers receive canonical actor/resource metadata, not raw channel ids or
  prompt text. This aligns with identity-graph and conversation-thread specs.
- Providers fail closed on error and timeout. A permission hook that cannot
  answer cannot safely authorize.
- Provider metadata lives in the app manifest because it is part of the app's
  operational contract. Discovery validates metadata but does not execute the
  provider.
- The implementation should support a provider-runtime facade before arbitrary
  external provider commands. `local-grants` may preserve current behavior, but
  it is not Ravi core.

## Rejected Alternatives

- **Keep a native grant graph plus app providers.** Rejected because it preserves
  the coupling we are removing. Grant behavior may remain only as a provider.
- **Put every app resource ACL into global grant tuples.** Rejected because it creates
  graph bloat, wildcard pressure, migration risk, and app/core coupling.
- **Let providers write each other's grants directly.** Rejected because it
  hides authority mutation outside provider ownership and makes revocation/audit
  unreliable.
- **Use only manifest `permissions.required`.** Rejected because static
  permission strings cannot express resource ownership, external ACL sync, or
  per-operation app state.
- **Run provider checks during discovery.** Rejected because discovery must be
  side-effect-free and fast.
- **Let app provider allow bypass all other providers.** Rejected because it
  creates privilege escalation. Provider composition must be explicit.

## Migration Direction

1. Introduce the Permission Provider Runtime facade.
2. Keep or replace current grant behavior behind a provider.
3. Move app-router authorization to the facade.
4. Move app-domain authorization out of ad-hoc command code into app providers.
5. Preserve denial explain and grant suggestions so operators still have an
   understandable remediation path.
