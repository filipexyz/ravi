---
id: sdk/client-codegen/dart
title: "Dart SDK Codegen Checks"
kind: feature
domain: sdk
status: draft
normative: false
---

# Dart SDK Codegen Checks

## Generator Unit Tests

The generator test suite MUST cover:

- deterministic emit for the same mock registry;
- nested namespace emission;
- lower camel case method names;
- positional arg parameters;
- trailing options classes;
- commands with no args/options;
- commands without `@Returns` returning `RaviJson`;
- binary commands returning `RaviBinaryResponse`;
- string enum mapping;
- complex union fallback to `RaviJson`;
- registry hash/version file emission;
- drift comparator ignoring only informational Git SHA.

## Generated Source Checks

`ravi sdk dart check --json` MUST report drift when any generated Dart file
differs from a fresh emit.

The check MUST include:

- generated file name;
- absolute path;
- reason;
- package/source directory.

## Dart Analyze Checks

When `dart` is available:

```bash
cd packages/ravi-os-dart-sdk
dart pub get
dart analyze
```

The analyze MUST pass without network access beyond `dart pub get` and without
a running Ravi daemon.

If `dart` is not installed in the environment, record that blocker explicitly.
Deterministic emitter tests and `ravi sdk dart check` MUST still run.

## Gateway Roundtrip

When the Dart toolchain is available in CI, add at least one smoke test that:

1. starts a local Ravi gateway with a small registry;
2. creates an artifact through test state;
3. calls `client.artifacts.show("...")` from Dart;
4. verifies the decoded response id/kind;
5. verifies validation errors map to `RaviValidationError`.

## Manual Spot Checks

Inspect generated Dart for:

- no command wrapper body like `{ args, options }`;
- flat JSON body keys match registry arg/option names;
- binary methods call `callBinary`;
- generated classes are public;
- no generated file imports `package:flutter`;
- no PATH `ravi` process spawn;
- no special-case that treats HTTP `{}` on `sessions.read` / `sessions.send`
  as a successful empty transcript.
