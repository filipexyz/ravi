---
id: sdk/client-codegen/rust
title: "Rust SDK Codegen - Runbook"
kind: runbook
domain: sdk
capability: client-codegen
feature: rust
owners:
  - dev
status: draft
---

# Runbook

## Audit The Current Registry

Use this to measure the current generated surface:

```bash
bun -e 'import "reflect-metadata"; import { getRegistry } from "./src/cli/registry-snapshot.ts"; const r=getRegistry(); const exposed=r.commands.filter(c=>!c.cliOnly); const withReturns=exposed.filter(c=>!!c.returns).length; const binary=exposed.filter(c=>c.binary).length; console.log(JSON.stringify({groups:r.groups.length,commands:r.commands.length,exposed:exposed.length,cliOnly:r.commands.length-exposed.length,withReturns,withoutReturns:exposed.length-withReturns,binary}, null, 2));'
```

## Implementation Order

1. Add `src/sdk/rust-codegen/` with pure emitters.
2. Reuse shared registry projection helpers where language-neutral.
3. Add conservative `json-schema-to-rust` mapping.
4. Add generated files under `packages/ravi-os-rust-sdk/src`.
5. Add hand-written transport/error/json files.
6. Add `ravi sdk rust generate/check`.
7. Add emitter tests before generating full package output.
8. Run drift checks and `cargo test` when available.

## Prior Art In Repo

- TypeScript backend: `src/sdk/client-codegen`.
- Swift backend: `src/sdk/swift-codegen`.
- Gateway contract: `src/sdk/gateway`.
- OpenAPI emitter: `src/sdk/openapi`.
