# Task 1 — Kimi Code provider contract, catalog, registry, and credential binding

## Status

Implemented and verified offline. No live credential, environment secret lookup, or network request was used.

## Implementation

- Added `KIMI_CODE_PROVIDER_ID` (`kimi-code`) and `KIMI_CODE_CREDENTIAL_ENV_KEY` (`KIMI_API_KEY`).
- Added the exact four Kimi Code membership models, selector recognition, and the complete K3 effort mapping:
  - absent / `medium` / `high` → `high`;
  - `minimal` / `low` → `low`;
  - `xhigh` / `max` / `ultra` → `max`;
  - `none` throws for K3 models;
  - fixed-thinking models always omit the K3 effort field.
- Added a native Kimi Code runtime provider with the approved, exact conservative v1 capability literal.
- `prepareSession(hostServices)` returns dynamic tools from `listDynamicTools()` and bridges calls to `executeDynamicTool`; legacy `supportsToolHooks` remains false.
- Registered `kimi-code` as a protected built-in provider and exposed it in the runtime model catalog with default model `k3`.
- Copied the four approved companion documents verbatim. Source/destination SHA-256 values were paired and identical for all four files.
- The transport/state implementation is intentionally deferred to later tasks. Until then, the provider creates a safe session handle that reports an offline configuration failure instead of reading credentials or attempting a request.

## Files

- Added `.ravi/specs/runtime/providers/kimi-code/{SPEC,WHY,RUNBOOK,CHECKS}.md`
- Added `src/runtime/kimi-code-models.ts`
- Added `src/runtime/kimi-code-models.test.ts`
- Added `src/runtime/kimi-code-provider.ts`
- Added `src/runtime/kimi-code-provider.test.ts`
- Updated `src/runtime/provider-registry.ts`
- Updated `src/runtime/provider-contract.test.ts`
- Updated `src/runtime/model-catalog.ts`
- Updated `src/runtime/model-catalog.test.ts`

## TDD evidence

### RED

Command:

```text
rtk proxy bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/model-catalog.test.ts src/runtime/provider-contract.test.ts
```

Relevant output:

```text
error: Cannot find module './kimi-code-models.js'
error: Cannot find module './kimi-code-provider.js'
model catalog > lists and resolves only the documented Kimi Code membership models
Expected: four Kimi model ids
Received: []
9 pass
4 fail
3 errors
```

### GREEN

Command:

```text
rtk proxy bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/model-catalog.test.ts src/runtime/provider-contract.test.ts
```

Relevant output:

```text
20 pass
0 fail
250 expect() calls
Ran 20 tests across 4 files.
```

Final required verification command:

```text
rtk proxy bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/model-catalog.test.ts src/runtime/provider-contract.test.ts; rtk proxy bun run typecheck
```

Relevant output:

```text
20 pass
0 fail
250 expect() calls
$ bun tsc --noEmit
```

During verification, TypeScript initially rejected returning the readonly canonical model list as a mutable catalog array (`TS4104`). Root cause was the `readonly KimiCodeModel[]` boundary. The sole minimal correction was returning a new array (`[...KIMI_CODE_MODELS]`); the final combined command above passed.

## Self-review

- Compared capability literal field-for-field with the approved task brief.
- Confirmed K3 and fixed-thinking effort behavior across every canonical effort.
- Confirmed only the four specified model ids are catalogued and the default is `k3`.
- Confirmed registration is additive and built-in unregister protection applies.
- Confirmed the provider does not read `process.env`; credential naming is an exported constant for the later `RuntimeStartRequest.env` transport path.
- Ran `git diff --check` successfully before finalization.

## Concerns

No blocking concern for Task 1. HTTP/SSE transport, credential injection into a request, and file-backed session state are deliberately not implemented here because they belong to later tasks; the present handle fails closed without external activity.
