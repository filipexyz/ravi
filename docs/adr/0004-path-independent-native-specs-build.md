# ADR 0004: Make native Specs builds path-independent

**Date:** 2026-08-21
**Status:** accepted

## Context

The Windows Specs addon was functionally correct, but its bytes contained the
absolute worktree and Zig compiler paths. That made the release artifact depend
on where it was built and disclosed local build details. PE timestamp
normalization alone could not remove this source-level variation.

## Decision

Compile from relative input and output paths, set a neutral compilation
directory, and use the Zig/Clang file, debug, and macro prefix maps for the
project, headers, and toolchain. Omit non-runtime debug metadata at link time
and keep PE timestamp normalization after linking. A native test builds Linux
and Windows addons in two different physical roots, requires identical bytes
and hashes, rejects either absolute root, and loads the addon for the host
platform to exercise a real snapshot.

## Alternatives considered

- **Post-process binary strings.** Rejected because rewriting linked data can
  corrupt offsets or signatures and would mask the compiler input instead of
  making compilation reproducible.
- **Accept the path leak.** Rejected because build location would remain part
  of the package and prevent byte-identical independent builds.
- **Build from one fixed path.** Rejected because it makes reproducibility
  depend on machine setup rather than source and supported compiler behavior.

## Consequences

- **Positive:** Independent roots produce the same addon bytes without local
  source or compiler roots, while the existing runtime behavior and normalized
  PE timestamps are preserved.
- **Negative/costs:** The build owns explicit compiler path-map flags, and the
  reproducibility test performs two cross-builds. Linux execution remains a
  Linux-host responsibility; Windows can only compare its cross-built bytes.

## Notes

This decision governs `scripts/build-specs-native.ts` and the generated Specs
addons only. It does not expand the native publication boundary.
