---
id: sdk/client-codegen/rust
title: "Rust SDK Codegen - Checks"
kind: checks
domain: sdk
capability: client-codegen
feature: rust
owners:
  - dev
status: draft
---

# Checks

When implemented, Rust codegen MUST pass:

```bash
bun test src/sdk/rust-codegen
ravi sdk rust generate --out packages/ravi-os-rust-sdk/src --json
ravi sdk rust check --out packages/ravi-os-rust-sdk/src --json
cargo test --manifest-path packages/ravi-os-rust-sdk/Cargo.toml
```

If `cargo` is not available in CI, the Rust build check MAY be skipped with a
clear note, but deterministic emitter tests MUST still run.

Regression coverage SHOULD include:

- deterministic emit across repeated runs;
- namespace and method naming;
- positional args;
- trailing options structs;
- zero-argument commands;
- unknown returns mapped to `serde_json::Value`;
- `@Returns(zod)` mapped to Rust structs/types;
- `@Returns.binary()` mapped to `RaviBinaryResponse`;
- generated HTTP transport path/body/header contract;
- drift check failing after generated file mutation.
