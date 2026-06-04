# Checks

Run these checks after changing the product runtime layer:

```bash
bun test src/runtime/product-runtime-contract.test.ts
ravi specs sync --json
git diff --check
```

Run the full runtime typecheck/build when dependencies are installed:

```bash
bun run typecheck
bun run build
```

Review rules:

- Product runtime code must not import router, session, database or channel
  internals as product-facing dependencies.
- Runtime events must remain operational Ravi events.
- Product-level Semantic Events, Bridge Contracts and SAL must remain product
  or framework-owned semantics.
- Bridge refs must not be represented as generic CRUD endpoints exposed by Ravi.
