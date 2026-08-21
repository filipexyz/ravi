# ADR 0004: Preserve required nullable key presence in generated Swift

## Status

Accepted locally on 2026-08-21. Promotion remains subject to independent
review and the normal CI gates.

## Context

JSON distinguishes an absent key from a key whose value is `null`. Swift's
`decodeIfPresent` maps both forms to `nil`, while `encodeIfPresent` omits `nil`.
That default pair violated Ravi schemas in two cases: a globally required and
nullable property, and a compact projection property required by the selected
union alternative. Candidate
`75cfa478f8cdb546f72386c5a079b3977db01882` therefore decoded a valid
`{"ownerAgentId":null}` item and re-encoded it as `{}`.

The same generator serves every domain. A Projects-only generated-file edit
would drift on the next regeneration and leave other required-nullable
contracts exposed.

## Decision

The global Swift generator records schema key obligations separately from the
optional Swift value:

- A globally required nullable key is checked with `contains`, decoded as an
  optional value, and explicitly encoded as `null` when its value is `nil`.
- A nullable key required by one compact-union alternative records whether the
  wire key was present. It re-encodes `nil` as `null` only when that key was
  present during decoding.
- A non-null key required by a compact-union alternative uses strict `decode`
  whenever its key is present, so JSON `null` is rejected.
- A truly optional absent key remains absent and is omitted when its Swift
  value is `nil`.

Generated artifacts are regenerated only from this source. Native generation
tests always inspect the emitted contract, and a Swift round-trip test compiles
and executes when `swiftc` is available; Swift compilation remains a CI gate on
hosts that provide the compiler.

## Alternatives considered

- Treat every optional Swift value as present and encode every `nil` as
  `null`. Rejected because it invents keys that were absent and changes truly
  optional contracts.
- Keep synthesized `Codable`. Rejected because synthesized decoding cannot
  preserve the distinction between an absent nullable key and a present null
  key.
- Patch only `RaviTypes.generated.swift`. Rejected because regeneration would
  erase the change and other domains use the same generator.
- Replace compact unions with untyped JSON. Rejected because it discards the
  generated contract that agents and SDK consumers rely on.

## Consequences

Generated Swift now round-trips required nulls without manufacturing absent
optional keys. Named compact models carry private wire-presence state, which is
not exposed as a public API field. Custom `Codable` remains limited to models
whose schema needs presence-aware behavior; ordinary models keep synthesized
coding where possible.
