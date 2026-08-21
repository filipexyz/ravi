# Postmortem 0004: Projects compact projections accepted malformed fields

## Status

Resolved locally on 2026-08-21. Promotion remains subject to independent
review and the normal CI gates.

## Impact

The Projects candidate at
`163c1565ac6833bc99fb3849f5bd7cf98137106a` was invalidated. Its compact read
surface silently discarded empty `--fields` tokens, and a requested optional
field could serialize as `{}` when absent. The generated contracts therefore
did not fully describe every successful payload.

## Detection

Independent adversarial review exercised empty input, comma-only input,
trailing commas, embedded empty tokens, and projection of an absent optional
field. The first four classes returned success after token filtering, while
the last class produced an empty object.

## Root cause

The shared parser normalized comma-separated input with a truthy-value filter,
which erased malformed tokens before validation. The projector also omitted
missing properties even when the caller had explicitly selected that property.
Schema generation described selected source fields but did not model a stable
representation for their absence.

## Correction

Contracted callers now reject every empty or unknown token with the documented
usage envelope. Projects projections represent a requested absent optional
field as `null`, and their runtime and generated schemas expose that field as
required and nullable in the corresponding compact variant. Native tests cover
the projector, real CLI processes, TypeScript generation, OpenAPI, and Swift.

## Prevention

- Parsers validate the original token structure before discarding data.
- Every compact projection test includes an absent optional field.
- Generated-contract tests verify both required membership and nullability.
- A candidate invalidation is recorded append-only; an earlier acceptance claim
  is never silently rewritten.
