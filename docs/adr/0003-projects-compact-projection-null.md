# ADR 0003: Represent absent requested Projects fields as null

## Status

Accepted on 2026-08-21 for compact Projects read projections.

## Context

Projects read commands accept `--fields` to reduce each returned item. Some of
the public fields are optional in the full representation. Selecting one of
those fields for an item where it is absent previously produced an empty JSON
object. That response did not prove which field had been requested and was not
honestly represented by the generated contracts.

The parser also discarded empty comma-separated tokens. Inputs such as a
trailing comma therefore looked valid after normalization instead of failing as
malformed usage.

## Decision

Every supplied field token is validated before projection. Empty tokens and
unknown names fail with `USAGE_ERROR`, exit 2, and `acceptedFields`.

When a valid requested field is absent or undefined, compact Projects
projections include that field with the value `null`. Required source fields
remain non-null. The Zod response schemas and generated OpenAPI, TypeScript,
and Swift contracts describe the same required-but-nullable compact variant.

The stricter behavior is enabled by callers that provide an accepted field
set. Existing users of the shared projector without that contract retain their
legacy behavior.

## Alternatives considered

- Reject a result whenever an optional field is absent. This was rejected
  because one sparse item would make a valid portfolio query unusable.
- Drop items that lack the selected field. This was rejected because it would
  silently alter ranking, pagination, and row counts.
- Omit the field from the projected object. This was rejected because a
  one-field projection could still serialize as `{}`.

## Consequences

Compact items always demonstrate the requested projection, and generated
clients can distinguish a known absent value from a field that was not
selected. Consumers must accept `null` for originally optional fields. Full
entity schemas and mutation payloads are unchanged.

## 2026-08-21 supersession note

The wire-contract decision remains valid, but the original Swift consequence
was incomplete in candidate
`75cfa478f8cdb546f72386c5a079b3977db01882`: its generated decoder collapsed a
selected key containing `null` and an absent key into the same Swift value, and
its encoder then omitted the key. ADR 0004 supersedes the Swift codec portion
of this decision. The rejected candidate remains in history and is not an
acceptable promotion source.
