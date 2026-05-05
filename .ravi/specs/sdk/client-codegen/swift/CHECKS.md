---
id: sdk/client-codegen/swift
title: "Swift SDK Codegen Checks"
kind: feature
domain: sdk
status: draft
normative: false
---

# Swift SDK Codegen Checks

## Generator Unit Tests

The generator test suite MUST cover:

- deterministic emit for the same mock registry;
- nested namespace emission;
- lower camel case method names;
- positional arg parameters;
- trailing options structs;
- commands with no args/options;
- commands without `@Returns` returning `RaviJSON`;
- binary commands returning `RaviBinaryResponse`;
- string enum mapping;
- complex union fallback to `RaviJSON`;
- registry hash/version file emission;
- drift comparator ignoring only informational Git SHA.

## Generated Source Checks

`ravi sdk swift check --json` MUST report drift when any generated Swift file
differs from a fresh emit.

The check MUST include:

- generated file name;
- absolute path;
- reason;
- package/source directory.

## Swift Build Checks

When `swift` is available:

```bash
cd packages/ravi-os-swift-sdk
swift build
swift test
```

The build MUST pass without network access and without a running Ravi daemon.

## Gateway Roundtrip

When the Swift toolchain is available in CI, add at least one smoke test that:

1. starts a local Ravi gateway with a small registry;
2. creates an artifact through test state;
3. calls `client.artifacts.show("...")` from Swift;
4. verifies the decoded response id/kind;
5. verifies validation errors map to `RaviError.validation`.

## Manual Spot Checks

Inspect generated Swift for:

- no command wrapper body like `{ args, options }`;
- flat JSON body keys match registry arg/option names;
- binary methods call `callBinary`;
- generated structs are `public`, `Codable`, and `Sendable`;
- no generated file imports SwiftUI or Combine.
