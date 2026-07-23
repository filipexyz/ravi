# CLI / CHECKS

## Checks

- Machine-consumed commands MUST support `--json`.
- List/search commands MUST NOT return unbounded data by default.
- JSON output SHOULD expose stable semantic fields for the same operation
  shapes across commands.
- Dangerous or expensive full-history scans MUST require explicit flags.
- Public SDK/OpenAPI commands MUST declare a typed return contract or be marked
  CLI-only.
- `bun test src/cli/registry.test.ts src/cli/schema-inference.test.ts src/sdk/client-codegen/codegen.test.ts`
  SHOULD pass after changing CLI registry or return schema behavior.
