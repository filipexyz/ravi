---
id: sdk/client-codegen/swift
title: "Swift SDK Codegen Runbook"
kind: feature
domain: sdk
status: draft
normative: false
---

# Swift SDK Codegen Runbook

## Create The Package

```bash
mkdir -p packages/ravi-os-swift-sdk/Sources/RaviSDK
```

Add a hand-written `Package.swift` with one library target named `RaviSDK`.

## Implement The Generator

Expected modules:

```text
src/sdk/swift-codegen/
  index.ts
  emit-files.ts
  naming.ts
  json-schema-to-swift.ts
  registry-shape.ts
  stable-swift.ts
```

Reuse TypeScript codegen projections where practical:

- command sorting by `fullName`;
- input schema projection;
- return schema projection;
- registry hash.

Keep Swift-specific naming and type rendering in Swift-specific modules.

## Add CLI Commands

Extend `src/cli/commands/sdk.ts` with:

```text
sdk.swift.generate
sdk.swift.check
```

The command shape should mirror `sdk.client.generate` and `sdk.client.check`.

## Validate

Run targeted checks:

```bash
bun test src/sdk/swift-codegen
bun src/cli/index.ts sdk swift generate --json
bun src/cli/index.ts sdk swift check --json
```

If Swift is installed:

```bash
cd packages/ravi-os-swift-sdk
swift build
swift test
```

Always run the repo build before declaring implementation complete:

```bash
bun run build
```

## Release Hygiene

- Verify generated SDK version matches `packages/ravi-os-swift-sdk/Package.swift`
  or an explicit release version input.
- Verify `RaviVersion.generated.swift` registry hash matches the live registry.
- Never edit `.generated.swift` files by hand.
