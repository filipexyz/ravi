# Live Operational Help / CHECKS

- [ ] Root help and runtime prompt MUST use the same operational context renderer.
- [ ] Runtime identity and bounded permissions MUST remain visible without context keys or credentials.
- [ ] Operating rules MUST reuse known context, batch only independent reads, and preserve ordered mutations and authorization.
- [ ] Progress guidance MUST be factual and task-scoped, with no fabricated ETA or new background notification policy.
- [ ] Run focused tests with isolated state: `RAVI_STATE_DIR="$(mktemp -d)" bun test --preload ./src/test/isolated-runtime-preload.ts src/runtime/runtime-operational-context.test.ts src/runtime/runtime-system-prompt.test.ts`.
- [ ] Run `make quality`; production hosts leave the full build and suite to required PR CI.

Prompt guidance must be evaluated after release for actual round counts and
user-visible progress; unit tests do not demonstrate model compliance or latency.
