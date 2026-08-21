# Postmortem 0005: Projects Swift key presence and WAL proof gaps

## Status

Corrected locally on 2026-08-21. Independent final audit, package, publication,
merge, and VPS validation have not been performed.

## Impact

Candidate `75cfa478f8cdb546f72386c5a079b3977db01882` is rejected and must not be
promoted. Its TypeScript, Zod, OpenAPI, and CLI projection behavior was correct,
but a generated Swift client could re-encode a selected null property as an
empty object. The active-WAL safety claim also depended on an unversioned
experiment, so future changes could regress it without a native test failure.

No package, push, pull request, merge, or VPS change was made from the rejected
candidate.

## Detection

Independent read-only review decoded `{"ownerAgentId":null}` through the
generated Swift shape and followed the encoder path. `decodeIfPresent` produced
`nil`, and `encodeIfPresent` then omitted the selected key. The same review
compared the documented WAL claim with the versioned test suite and found no
test that kept a writer open while a separate Ravi process read the database.

## Root cause

The global Swift generator represented both schema optionality and nullable
values with one Swift optional. It retained no wire-key presence for fields
required only by one union alternative. The earlier implementation also
treated a manually executed WAL proof as sufficient evidence instead of
turning the exact concurrency boundary into a permanent regression test.

## Correction

The Swift generator now separates key obligation from value nullability. It
preserves present-null keys, omits truly absent optional keys, rejects an empty
compact projection, and strictly decodes a selected non-null field. Generated
Swift artifacts are rebuilt from that source.

The Projects process suite now creates a WAL database, disables automatic
checkpointing, keeps the writer connection open, invokes Ravi in a separate
process, and compares the main database and WAL byte-for-byte before and after
the read.

## Prevention

- Every required-nullable Swift contract has generation assertions and a
  compiler-backed round-trip when `swiftc` is available.
- Compact-union tests cover present null, absent optional, empty object, and a
  present null for a non-null field.
- Filesystem safety claims become versioned native tests at the exact process
  and concurrency boundary.
- Candidate approval records identify compiler and platform limits and never
  turn an unavailable gate into a passing claim.
