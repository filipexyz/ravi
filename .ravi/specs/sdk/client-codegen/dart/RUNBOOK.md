---
id: sdk/client-codegen/dart
title: "Dart SDK Codegen Runbook"
kind: feature
domain: sdk
status: draft
normative: false
---

# Dart SDK Codegen Runbook

## Create The Package

```bash
mkdir -p packages/ravi-os-dart-sdk/lib/src packages/ravi-os-dart-sdk/example
```

Add a hand-written `pubspec.yaml` with package name `ravi_sdk` and no
Flutter SDK dependency.

## Implement The Generator

Expected modules:

```text
src/sdk/dart-codegen/
  index.ts
  emit-files.ts
  naming.ts
  json-schema-to-dart.ts
  streaming-codegen.ts
```

Reuse TypeScript codegen projections where practical:

- command sorting by `fullName`;
- input schema projection;
- return schema projection;
- registry hash.

Keep Dart-specific naming and type rendering in Dart-specific modules.

## Add CLI Commands

Extend `src/cli/commands/sdk.ts` with:

```text
sdk.dart.generate
sdk.dart.check
```

The command shape should mirror `sdk.client.generate` / `sdk.swift.generate`
and `sdk.client.check` / `sdk.swift.check`.

Default output directory:

```text
packages/ravi-os-dart-sdk/lib/src
```

## Validate

Run targeted checks from the repo root:

```bash
bun test src/sdk/dart-codegen
bun src/cli/index.ts sdk dart generate --json
bun src/cli/index.ts sdk dart check --json
```

Adding `sdk.dart.*` commands changes `RegistrySnapshot`. After the CLI group
lands, refresh the other registry projections so drift checks stay green:

```bash
bun src/cli/index.ts sdk client generate
bun src/cli/index.ts sdk swift generate
bun src/cli/index.ts sdk openapi emit --out docs/openapi.json
bun src/cli/index.ts sdk openapi emit --out openapi.json
```

If Dart is installed:

```bash
cd packages/ravi-os-dart-sdk
dart pub get
dart analyze
```

Always run the repo build before declaring implementation complete:

```bash
bun run build
```

## Release Hygiene

- Verify generated SDK version matches `packages/ravi-os-dart-sdk/pubspec.yaml`
  or an explicit release version input.
- Verify `ravi_version.generated.dart` registry hash matches the live registry.
- Never edit `.generated.dart` files by hand.
