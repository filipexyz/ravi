# Client Codegen — Checks

- Run `bun test src/sdk/client-codegen/codegen.test.ts`: the kebab/snake fixture
  must import and send raw request keys with the correct values; optional and
  variadic arguments must retain their existing semantics.
- In the same suite, distinct `artifactId`, `artifact_id`, and `artifact-id`
  values and an argument named `options` must survive transport serialization.
- An accepted `__proto__` argument must remain an own request-body property
  after importing and invoking the generated client, survive JSON serialization,
  and leave the request object's prototype unchanged.
- `Class`, `Await`, and strict-only names such as `Arguments` must fail
  generation explicitly after normalization, instead of emitting illegal
  parameter bindings; non-identifier punctuation must also fail explicitly.
- A method named `class` with option property `default` must import and execute
  successfully, proving that legal keyword properties remain accepted.
- The checked-in `packages/ravi-os-sdk/src/client.ts` must parse and import in
  the same suite, independently of the root TypeScript include list.
- Run `bun test src/sdk/swift-codegen/codegen.test.ts src/sdk/dart-codegen/codegen.test.ts`
  when checking cross-language fixture parity; both backends must retain raw
  wire keys for their normalized local identifiers.
- Run `bun run sdk:check` in CI to verify deterministic on-disk output. A passing
  drift check must not replace the emitted-source import/invocation checks.
- Confirm gateway `normalizeBody` and `validateAndPack`, input schemas, and
  OpenAPI still resolve the raw registry argument names, with no new aliases.

On the production host, obtain the coordinated test slot before focused checks.
Leave the full build, root typecheck, and full suite to CI.

- `bun test src/sdk/client-codegen/codegen.test.ts` verifies normalized optional arguments before a required options bag and preserves their raw wire keys at invocation.
