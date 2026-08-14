# Kimi Code Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Hardening design:** [Kimi Code Provider Hardening Design](../specs/2026-08-11-kimi-code-provider-hardening-design.md)

**Goal:** Add a first-class, additive `kimi-code` runtime provider that uses the Kimi Code membership Chat Completions endpoint without changing Claude, Codex, Pi, or the existing Kimi-through-Pi path.

**Architecture:** The adapter owns an injectable HTTP/SSE transport, a model/request mapper, and immutable file-backed transcript snapshots. It converts provider chunks into canonical runtime events, executes tools serially through Ravi host services, preserves provider reasoning privately for protocol continuity, and delegates credentials, replay, cooldown, and terminal arbitration to existing Ravi authorities.

**Tech Stack:** TypeScript, Bun test runner, native `fetch`, Web Streams, Ravi runtime provider contracts.

## Global Constraints

- Target RAVI `dev` baseline `e05e4c9b35889c2bd9886283b42a4948242fa72c` plus the isolated-worktree ignore commit.
- Provider id is exactly `kimi-code`; endpoint is `https://api.kimi.com/coding/v1/chat/completions`; credential target is exactly `KIMI_API_KEY`.
- Models are exactly `k3`, `k3-256k`, `kimi-for-coding`, and `kimi-for-coding-highspeed`.
- K3 effort mapping is `minimal|low -> low`, `medium|high -> high`, `xhigh|max|ultra -> max`, absent -> `high`, and `none` fails.
- Fixed-thinking models omit K3 reasoning fields for every canonical effort value.
- V1 is text-only, serial-tools-only, resume true, fork false, MCP/plugins/remote spawn false, and `supportsToolHooks` false.
- The provider performs no credential rotation, cooldown, ambiguous-turn reconciliation, or automatic retry after handoff.
- Preserved reasoning, credentials, complete prompts, tool secrets, and raw provider bodies never enter public events or fixtures.
- All default tests are offline and synthetic. Live tests remain opt-in and require a newly rotated key supplied outside chat.
- Production changes follow RED -> GREEN -> REFACTOR; every task records the failing and passing command.

---

### Task 1: Land the provider contract, catalog, registry, and credential binding

**Files:**
- Create: `.ravi/specs/runtime/providers/kimi-code/SPEC.md`
- Create: `.ravi/specs/runtime/providers/kimi-code/WHY.md`
- Create: `.ravi/specs/runtime/providers/kimi-code/RUNBOOK.md`
- Create: `.ravi/specs/runtime/providers/kimi-code/CHECKS.md`
- Create: `src/runtime/kimi-code-models.ts`
- Create: `src/runtime/kimi-code-models.test.ts`
- Create: `src/runtime/kimi-code-provider.ts`
- Create: `src/runtime/kimi-code-provider.test.ts`
- Modify: `src/runtime/provider-registry.ts`
- Modify: `src/runtime/provider-contract.test.ts`
- Modify: `src/runtime/model-catalog.ts`
- Modify: `src/runtime/model-catalog.test.ts`

**Interfaces:**
- Produces: `KIMI_CODE_PROVIDER_ID`, `KIMI_CODE_MODELS`, `isKimiCodeModel`, `resolveKimiCodeEffort`, and `createKimiCodeRuntimeProvider`.
- `resolveKimiCodeEffort(model, effort)` returns `"low" | "high" | "max" | undefined` and throws on unsupported K3 values.

- [ ] **Step 1: Write catalog/model/registry/provider-contract tests that fail because `kimi-code` is absent.**

Use literal expectations for the four model ids, default `k3`, exact capability object, built-in unregister protection, and effort table. The provider test must assert `prepareSession(hostServices)` returns `dynamicTools` and `handleRuntimeToolCall`, while `supportsToolHooks` remains false.

- [ ] **Step 2: Run the failing tests.**

Run: `bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/model-catalog.test.ts src/runtime/provider-contract.test.ts`

Expected: FAIL because modules/provider registration do not exist.

- [ ] **Step 3: Implement the model helpers, conservative provider skeleton, catalog entries, registry factory, and host-service bridge.**

The capability literal must be:

```ts
{
  runtimeControl: { supported: false, operations: [] },
  dynamicTools: { mode: "host" },
  execution: { mode: "external-service" },
  sessionState: { mode: "file-backed", requiresCwdMatch: true },
  usage: { semantics: "terminal-event" },
  tools: { permissionMode: "ravi-host", accessRequirement: "tool_surface", supportsParallelCalls: false },
  systemPrompt: { mode: "append" },
  terminalEvents: { guarantee: "adapter" },
  skillVisibility: { availability: "none", loadedState: "none" },
  supportsSessionResume: true,
  supportsSessionFork: false,
  supportsPartialText: true,
  supportsToolHooks: false,
  supportsHostSessionHooks: false,
  supportsPlugins: false,
  supportsMcpServers: false,
  supportsRemoteSpawn: false,
  toolAccessRequirement: "tool_surface",
}
```

`prepareSession` consumes `hostServices.listDynamicTools()` and bridges `executeDynamicTool`; it must not read `process.env`.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/model-catalog.test.ts src/runtime/provider-contract.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `feat(runtime): register kimi code provider`

### Task 2: Implement request mapping and injectable HTTP/SSE transport

**Files:**
- Create: `src/runtime/kimi-code-transport.ts`
- Create: `src/runtime/kimi-code-transport.test.ts`
- Extend: `src/runtime/kimi-code-provider.ts`
- Extend: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Produces `KimiCodeTransport`, `KimiCodeTransportRequest`, `KimiCodeStreamEvent`, `createKimiCodeHttpTransport`, and `buildKimiCodeRequest`.
- Factory accepts `{ fetch?: typeof fetch; baseUrl?: string; userAgent?: string }` for offline tests.
- Authorization is derived only from `RuntimeStartRequest.env?.KIMI_API_KEY`.

- [ ] **Step 1: Write failing request/transport tests.**

Cover exact URL, Bearer header, honest `ravi/<version>` user agent, `Accept: text/event-stream`, `stream: true`, `stream_options: { include_usage: true }`, stable `prompt_cache_key`, system append, 2 MiB UTF-8 message rejection, K3 effort body, fixed-thinking omission, missing key, non-2xx response, CRLF/LF SSE, comments, multiline data, `[DONE]`, split UTF-8 chunks, and abort.

- [ ] **Step 2: Run tests and verify RED.**

Run: `bun test src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-provider.test.ts`

Expected: FAIL on missing transport/request mapper.

- [ ] **Step 3: Implement minimal native-fetch transport and incremental SSE parser.**

The transport must expose provider JSON only to the adapter, cap retained SSE buffer size, close/abort idempotently, and never include authorization or raw response bodies in thrown errors.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `bun test src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-provider.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `feat(runtime): add kimi code streaming transport`

### Task 3: Normalize streaming events and enforce terminality

**Files:**
- Extend: `src/runtime/kimi-code-provider.ts`
- Extend: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Consumes `KimiCodeStreamEvent`.
- Produces one `RuntimeSessionHandle` whose `events` yields canonical `turn.started`, bounded thinking status, text deltas, one final assistant message, usage, and exactly one terminal event.

- [ ] **Step 1: Write failing synthetic stream tests.**

Fixtures cover interleaved `reasoning_content`, `content`, indexed fragmented tool calls, usage-only final chunk, `[DONE]`, malformed JSON, EOF without `[DONE]`, provider error, abort before output, abort after partial output, duplicate finish chunks, and empty assistant output.

- [ ] **Step 2: Verify RED.**

Run: `bun test src/runtime/kimi-code-provider.test.ts`

Expected: FAIL because the session event loop is absent.

- [ ] **Step 3: Implement the turn state machine and terminal tracker integration.**

Never emit preserved reasoning as `text.delta`, `assistant.message`, `provider.raw`, or error text. A successful no-tool response emits exactly one `turn.complete` with `execution: { provider: "kimi-code", model, billingType: "subscription" }` and terminal usage.

- [ ] **Step 4: Run focused tests and typecheck.**

Run: `bun test src/runtime/kimi-code-provider.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `feat(runtime): normalize kimi code stream events`

### Task 4: Implement serial dynamic-tool loop

**Files:**
- Extend: `src/runtime/kimi-code-provider.ts`
- Extend: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Consumes `RuntimeDynamicToolSpec[]` and `RuntimeDynamicToolCallHandler` from the prepared start request.
- Appends native assistant `tool_calls` and role `tool` results with the original `tool_call_id` before the next request.

- [ ] **Step 1: Write failing tool-loop tests.**

Cover one successful call, denied/failed host result, thrown handler, malformed JSON arguments, two calls executed serially in index order, duplicate id rejection, `tool.started` immediately before dispatch, paired `tool.completed`, `tool.result_delivered`, exactly-once execution, and abort between calls.

- [ ] **Step 2: Verify RED.**

Run: `bun test src/runtime/kimi-code-provider.test.ts -t tool`

Expected: FAIL because tool continuation is absent.

- [ ] **Step 3: Implement the serial loop.**

Convert `contentItems` to bounded text for the provider, propagate `success` as tool error semantics without inventing a third decision state, and never execute until all argument fragments form valid JSON.

- [ ] **Step 4: Run provider tests and typecheck.**

Run: `bun test src/runtime/kimi-code-provider.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `feat(runtime): route kimi tools through host services`

### Task 5: Implement immutable file-backed continuity

**Files:**
- Create: `src/runtime/kimi-code-state.ts`
- Create: `src/runtime/kimi-code-state.test.ts`
- Extend: `src/runtime/kimi-code-provider.ts`
- Extend: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Produces `KimiCodeSessionSnapshot`, `loadKimiCodeSessionState`, and `commitKimiCodeSessionState`.
- State params contain `schemaVersion`, `provider`, `model`, `sessionId`, `revision`, `cwd`, `sessionFile`, and `lastCommittedTurnId`.

- [ ] **Step 1: Write failing state/resume tests.**

Use a temporary RAVI state dir and cover new UUID session, atomic revision commit, private file mode where supported, previous revision retained, crash before publication leaves old locator valid, failed/interrupted turn commits nothing, cwd mismatch, model mismatch, provider mismatch, schema mismatch, corrupt JSON, missing file, path escape/symlink rejection, bounded state, preserved reasoning/tool pairing, and fork rejection.

- [ ] **Step 2: Verify RED.**

Run: `bun test src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts -t resume`

Expected: FAIL because the state store is absent.

- [ ] **Step 3: Implement immutable snapshots under `getRaviStateDir()/runtime/kimi-code/sessions/<sessionId>/`.**

Write a new temp file, fsync/close where supported, atomically rename, then expose the new locator only in `turn.complete`. Validate resolved paths remain under the provider state root and preserve private reasoning only inside the protected snapshot.

- [ ] **Step 4: Run state/provider tests and typecheck.**

Run: `bun test src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `feat(runtime): persist kimi code session snapshots`

### Task 6: Integrate Kimi-specific credential failure classification and safe quota handling

**Files:**
- Modify: `src/runtime/credential-classifier.ts`
- Modify: `src/runtime/credential-classifier.test.ts`
- Modify: `src/runtime/credential-store.ts`
- Modify: `src/runtime/credential-store.test.ts`
- Extend: `src/runtime/kimi-code-provider.ts`
- Extend: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Extends `classifyRuntimeCredentialFailure` without adding a provider-local enum.
- Kimi message semantics run before generic status fallback.

- [ ] **Step 1: Write failing literal fixtures for official 401/402/403/429 message families and reset/no-reset behavior.**

Assert invalid key -> `auth_invalid`; entitlement/model/context messages are not auth; weekly/5-hour/monthly quota -> `quota_exhausted`; concurrency/overload -> `rate_limited`; access terminated -> permission/account; unrecognized Kimi error -> `unknown`; quota without authoritative reset has no invented 24-hour expiry.

- [ ] **Step 2: Verify RED.**

Run: `bun test src/runtime/credential-classifier.test.ts src/runtime/credential-store.test.ts src/runtime/kimi-code-provider.test.ts -t Kimi`

Expected: FAIL on generic status-first behavior and fallback cooldown.

- [ ] **Step 3: Implement provider-aware precedence and indefinite exhausted state.**

Do not add provider-local retries or rotation. Preserve generic behavior for Claude, Codex, Pi, and unknown providers.

- [ ] **Step 4: Run credential/provider regression tests and typecheck.**

Run: `bun test src/runtime/credential-classifier.test.ts src/runtime/credential-store.test.ts src/runtime/kimi-code-provider.test.ts && bun run typecheck`

Expected: PASS.

- [ ] **Step 5: Commit.**

Commit message: `fix(runtime): classify kimi credential limits safely`

### Task 7: Add security, cost, integration, and regression gates

**Files:**
- Extend: `src/runtime/kimi-code-provider.test.ts`
- Extend: `src/runtime/provider-contract.test.ts`
- Extend: `src/runtime/model-catalog.test.ts`
- Modify or extend tests for: `src/costs/pricing-catalog.ts`
- Create: `src/runtime/kimi-code-provider.live.test.ts`
- Modify: documentation indexes required by the repository.

**Interfaces:**
- Validates the complete provider as seen by registry, request builder, host services, session state, classifier, and cost reporting.

- [ ] **Step 1: Write failing integration/security tests.**

Add sentinels for key, authorization, prompt, path, reasoning, tool input/output, response body, and exception. Assert no sentinel reaches public events, logs, snapshots visible outside the private state file, or committed fixtures. Assert a Kimi model id cannot inherit another provider's price by coincidence. Assert all unsupported capabilities fail deterministically.

- [ ] **Step 2: Verify RED.**

Run the new integration tests and confirm each fails for the intended missing boundary.

- [ ] **Step 3: Implement only the minimal boundary fixes needed for GREEN and add an opt-in live smoke scaffold.**

The live test must skip unless `RAVI_LIVE_TESTS=1` and `KIMI_API_KEY` are present, use a synthetic prompt, redact all evidence, and never run in default CI.

- [ ] **Step 4: Run all focused gates.**

Run: `bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/provider-contract.test.ts src/runtime/model-catalog.test.ts src/runtime/credential-classifier.test.ts src/runtime/credential-store.test.ts && bun run typecheck && bun run build`

Expected: PASS.

- [ ] **Step 5: Run the repository regression suite.**

Run: `bun run test`

Expected: PASS. If the command exceeds the harness timeout, rerun its package-script groups individually and record every result.

- [ ] **Step 6: Run sanitization scans.**

Search the complete diff for credential-shaped strings, the revoked chat key prefix, personal paths/data, raw prompts, and provider reasoning. Expected: zero sensitive matches.

- [ ] **Step 7: Commit.**

Commit message: `test(runtime): harden kimi code provider boundaries`

### Task 8: Final whole-branch review and release-gate accounting

**Files:**
- Modify only files required to address reviewed defects.
- Update `.ravi/specs/runtime/providers/kimi-code/CHECKS.md` with executed offline evidence; do not claim live gates passed.

**Interfaces:**
- Produces a review-ready branch, not a public PR and not a production rollout.

- [ ] **Step 1: Package the full branch diff and dispatch a fresh whole-branch reviewer.**

Reviewer must check spec compliance, concurrency/abort safety, replay fences, secret/reasoning boundaries, path traversal, parser bounds, credential precedence, quota behavior, provider regressions, and public-contribution sanitization.

- [ ] **Step 2: Apply one reviewed fix wave and one scoped re-review if needed.**

No finding may be silently discarded. Load-bearing unresolved findings block completion.

- [ ] **Step 3: Re-run focused tests, typecheck, build, full regression suite, docs checks, and secret scans from a clean status.**

Expected: all offline gates pass; L-01 through L-04 remain explicitly pending until tested with a new private credential.

- [ ] **Step 4: Present branch integration options without pushing or opening a PR.**

Do not publish upstream until the user authorizes it and the live evidence gates pass.
