# Tools / WHY

## Rationale

The tools domain needs a normative spec to anchor the contract for how CLI
commands are exposed, discovered, and executed through the SDK surface.

Without a top-level spec, the registry contract is scattered across
implementation files and there is no single source of truth for the invariants
that discovery commands MUST be read-only and that real execution MUST be
explicit.

## Decisions

- Create `tools` as a domain spec that owns the safety invariants.
- Delegate registry-specific contract (search, dry-run, invoke) to `tools/registry`.
- Keep the spec minimal; implementation details live in `tools/registry`.
