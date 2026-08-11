# Kimi Code Provider Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Correct every confirmed adversarial finding on PR #406 while preserving the first-class Kimi Code provider's intentionally narrow capability surface.

**Architecture:** Keep `.ravi/specs/runtime/providers/kimi-code/SPEC.md` normative and harden four existing boundaries: native protocol assembly, HTTP/SSE transport, provider lifecycle, and immutable continuity. Add only two cross-runtime integrations: a model-aware continuity reset and an explicit Kimi availability gate; Claude, Codex, and Pi behavior must remain byte-for-byte compatible at their tested boundaries.

**Tech Stack:** TypeScript, Bun test runner, native `fetch`, Web Streams, Node filesystem APIs, RAVI runtime provider contracts.

**Design:** [Kimi Code Provider Hardening Design](../specs/2026-08-11-kimi-code-provider-hardening-design.md)

## Global Constraints

- Normative authority is `.ravi/specs/runtime/providers/kimi-code/SPEC.md`; this plan may refine implementation shape but may not weaken it.
- Every production change follows RED -> GREEN -> REFACTOR, and the RED output must demonstrate the intended defect rather than a fixture error.
- Production endpoint remains exactly `https://api.kimi.com/coding/v1/chat/completions`; credentials are attached only to origin `https://api.kimi.com`.
- The request limit is 2 MiB over the UTF-8 encoding of the complete serialized native request body, not per message.
- Provider id, models, effort mapping, capabilities, subscription billing, serial tool execution, and unsupported features remain unchanged.
- Preserved reasoning, prompts, tool inputs/results, bearer values, response bodies, personal paths, and the credential disclosed in chat must not enter events, errors, fixtures, reports, commits, or PR comments.
- [The Kimi Code SPEC](../../../.ravi/specs/runtime/providers/kimi-code/SPEC.md) is the only normative source for the session-start gate and rollback policy. The [runbook](../../../.ravi/specs/runtime/providers/kimi-code/RUNBOOK.md) is an operational guide aligned to the SPEC, and [CHECKS](../../../.ravi/specs/runtime/providers/kimi-code/CHECKS.md) records verification evidence; this plan does not restate policy.
- A native success committed before a later abort wins; an ambiguous network handoff is never replayed automatically.
- Every published `tool.started` has exactly one matching `tool.completed`, including cancellation before host dispatch.
- Offline gates must pass on Windows and Linux. Private live gates require a newly issued credential supplied outside chat and remain merge-blocking until recorded.

---

### Task 1: Make native turn assembly fail closed

**Files:**
- Modify: `src/runtime/kimi-code-turn.ts`
- Modify: `src/runtime/kimi-code-turn.test.ts`

**Interfaces:**
- Produces: `KimiCodeCompletedTurn.finishReason: "stop" | "tool_calls"`.
- Produces: `KimiCodeNativeError` projection containing only bounded `status`, `code`, `type`, `requestId`, and classifier inputs.
- Preserves: `createKimiCodeCompletedTurnAccumulator()` and `addKimiCodeUsage()` call sites.

- [ ] **Step 1: Add literal failing tests for terminal coherence and malformed native shapes.**

Add tests named:

```ts
it("retains stop and tool_calls finish reasons in the completed turn", () => {});
it("rejects length and content_filter before any tool can be dispatched", () => {});
it("rejects tool_calls finish reason without a complete tool call", () => {});
it("rejects a complete tool call unless finish reason is tool_calls", () => {});
it("rejects a negative or unsafe tool fragment index", () => {});
it("rejects id or function-name mutation for an existing tool index", () => {});
it("rejects an event with no recognized native field", () => {});
it("accepts additive unknown fields when a recognized field is valid", () => {});
it("rejects non-safe usage values and checked-addition overflow", () => {});
it("projects structured provider errors without retaining message or body", () => {});
```

Use hand-written chunks and literal outcomes. For the overflow case, use `Number.MAX_SAFE_INTEGER` and `1`; for mutation, send two fragments at index `0` with different ids and names. The structured error fixture includes secret sentinels in `message`, `body`, and unknown properties and asserts none survive.

- [ ] **Step 2: Run the turn tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-turn.test.ts`

Expected: FAIL because finish reason is discarded, unsafe numbers/indices are accepted, identity can mutate, and unknown-only shapes are treated as valid.

- [ ] **Step 3: Add the minimal typed protocol state.**

Implement the equivalent of:

```ts
type KimiCodeTerminalFinishReason = "stop" | "tool_calls";

interface KimiCodeCompletedTurn {
  finishReason: KimiCodeTerminalFinishReason;
  text: string;
  reasoning: string;
  toolCalls: readonly KimiCodeCompletedToolCall[];
  usage: KimiCodeUsage;
}

function checkedTokenCount(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw protocol("invalid_usage");
  return value as number;
}
```

Keep the first non-empty id/name per tool index immutable, reject indices outside the existing total-tool bound, require at least one recognized field per event, and allow unknown additive keys only after a recognized field validates. Map `length`, `content_filter`, missing/inconsistent finish reason, and unsafe usage to fixed protocol codes. Never retain arbitrary native strings.

- [ ] **Step 4: Verify GREEN and mutation coverage.**

Run: `rtk bun test src/runtime/kimi-code-turn.test.ts`

Then temporarily change the immutable-name comparison to accept a replacement, rerun the named mutation test and observe FAIL, restore the implementation, and rerun the file.

Expected: all turn tests PASS after restoration.

- [ ] **Step 5: Commit Task 1.**

Run:

```text
rtk git add -- src/runtime/kimi-code-turn.ts src/runtime/kimi-code-turn.test.ts
rtk git commit -m "fix(runtime): validate kimi native turns"
```

### Task 2: Harden request preflight and HTTP handoff

**Files:**
- Modify: `src/runtime/kimi-code-transport.ts`
- Modify: `src/runtime/kimi-code-transport.test.ts`

**Interfaces:**
- Produces: `KimiCodePreflightError` with fixed `code` and `recoverable = false`.
- Produces: `KimiCodeTransportError.phase: "request_not_sent" | "acceptance_ambiguous" | "provider_protocol"`.
- Changes: `createKimiCodeHttpTransport({ fetch?, userAgent? })` no longer accepts any origin override; injected fetch remains sufficient for offline tests.

- [ ] **Step 1: Add failing request and transport regressions.**

Add tests named:

```ts
it("places system policy before the transcript on first and tool-continuation requests", () => {});
it("rejects a serialized native body larger than 2 MiB even when each message is smaller", () => {});
it("returns typed non-recoverable preflight failures for key model effort and size", () => {});
it("never attaches authorization to a non-Kimi production origin", () => {});
it("classifies a fetch rejection before acceptance as request_not_sent", () => {});
it("classifies failure after response acceptance as acceptance_ambiguous", () => {});
it("classifies malformed accepted SSE as provider_protocol", () => {});
it("removes combined abort listeners after every stream round", () => {});
it("ends an aborted pending reader without converting it to eof", () => {});
```

The ordering expectation is literal `system,user,assistant,tool`. Build two 1.1 MiB user/tool contents and assert aggregate rejection. Instrument `addEventListener`/`removeEventListener` counts on a real signal for cleanup; do not assert only on a fetch mock.

- [ ] **Step 2: Run transport tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-transport.test.ts`

Expected: FAIL on aggregate size, late system placement, generic errors, arbitrary authenticated base URL, listener retention, and ambiguous abort/eof behavior.

- [ ] **Step 3: Implement exact-body preflight and phased transport errors.**

Create the native body before headers, then enforce:

```ts
const serializedBody = JSON.stringify(body);
if (new TextEncoder().encode(serializedBody).byteLength > 2 * 1024 * 1024) {
  throw new KimiCodePreflightError("request_too_large");
}
```

Build messages as `systemPromptAppend ? [{ role: "system", ... }, ...messages] : [...messages]`. Remove `baseUrl` from the transport options and keep the production URL fixed; injected fetch can return offline responses without changing the requested URL. Before attaching headers, assert `new URL(request.url).origin === "https://api.kimi.com"`. Track transport phase before fetch, after fetch resolution, and during stream parsing. Replace permanent combined-signal listeners with `AbortSignal.any` when available or a helper returning `{ signal, cleanup }` called from `finally`.

- [ ] **Step 4: Verify GREEN and typecheck.**

Run: `rtk bun test src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-turn.test.ts`

Run: `rtk bun run typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit Task 2.**

Run:

```text
rtk git add -- src/runtime/kimi-code-transport.ts src/runtime/kimi-code-transport.test.ts
rtk git commit -m "fix(runtime): harden kimi request transport"
```

### Task 3: Make provider terminal transitions deterministic

**Files:**
- Modify: `src/runtime/kimi-code-provider.ts`
- Modify: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Consumes: Task 1 `finishReason` and Task 2 typed errors/phases.
- Produces: one `thread.started` per new transcript, non-empty public assistant messages, and first-winner terminal behavior.

- [ ] **Step 1: Add iterator-controlled failing lifecycle tests.**

Add tests named:

```ts
it("emits thread.started before the first turn of a new transcript and never on resume", async () => {});
it("does not emit assistant.message when public text is empty", async () => {});
it("committed native success wins over an abort after assistant publication", async () => {});
it("maps an aborted pending reader to turn.interrupted", async () => {});
it("does not dispatch tools for length or content_filter", async () => {});
it("projects preflight codes as non-recoverable canonical failures", async () => {});
it("marks acceptance_ambiguous without retrying the native request", async () => {});
```

Manually advance the async iterator to the suspension point, call `handle.interrupt()`, then assert the next and final event. Assert the transport start count remains exactly one for ambiguous handoff.

- [ ] **Step 2: Run provider lifecycle tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-provider.test.ts -t "thread.started|assistant.message|committed native success|pending reader|length|content_filter|preflight|acceptance_ambiguous"`

Expected: each new regression fails on the audited behavior.

- [ ] **Step 3: Implement an explicit internal phase and commit-before-yield rule.**

Represent phases with a closed union:

```ts
type KimiCodeTurnPhase =
  | "initializing" | "requesting" | "streaming" | "committing"
  | "tool-fenced" | "tool-running" | "continuing"
  | "completed" | "failed" | "interrupted";
```

After durable state commit, assign `committedSnapshot` and phase `completed` before yielding `assistant.message`; a later abort may close resources but cannot replace `turn.complete`. Recheck abort immediately after stream iteration ends and before the generic incomplete-stream branch. Branch on Task 1 `finishReason`, and project Task 2 typed errors without a generic recoverable wrapper. Emit a UUID-backed `thread.started` once on a fresh session and suppress empty assistant text.

- [ ] **Step 4: Verify GREEN plus existing provider contract.**

Run: `rtk bun test src/runtime/kimi-code-provider.test.ts src/runtime/provider-contract.test.ts`

Run: `rtk bun run typecheck`

Expected: both commands exit 0.

- [ ] **Step 5: Commit Task 3.**

Run:

```text
rtk git add -- src/runtime/kimi-code-provider.ts src/runtime/kimi-code-provider.test.ts
rtk git commit -m "fix(runtime): make kimi terminal transitions atomic"
```

### Task 4: Pair every published tool lifecycle

**Files:**
- Modify: `src/runtime/kimi-code-provider.ts`
- Modify: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Consumes: Task 3 `KimiCodeTurnPhase` terminal rules.
- Produces: exactly one `tool.completed` for each yielded `tool.started`; host dispatch remains at-most-once.

- [ ] **Step 1: Add failing cancellation-fence tests.**

Add tests that manually interrupt immediately after consuming `tool.started`, during host execution, and between two serialized calls. Expected public sequence for a call cancelled before dispatch is:

```ts
["turn.started", "tool.started", "tool.completed", "turn.interrupted"]
```

Assert `tool.completed` has the same id/name, `isError: true`, bounded public content `"Tool execution cancelled."`, no `tool.result_delivered`, and host handler count `0`. During execution, handler count is `1`; after completion, never invoke it again.

- [ ] **Step 2: Run the tool tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-provider.test.ts -t "tool lifecycle|cancelled before dispatch|during host execution|between serialized calls"`

Expected: FAIL because the provider currently yields `turn.interrupted` with an open tool obligation.

- [ ] **Step 3: Implement a single tool obligation helper.**

Use a local obligation record `{ id, name, completed }`. Immediately after `tool.started` is yielded, every exit path must call one helper that emits the matching completion once. Cancellation before dispatch uses the fixed cancelled view; thrown/failed handlers preserve current failed-tool semantics; successful host results retain `tool.result_delivered`. Do not wrap or retry `handleRuntimeToolCall`.

The helper contract is:

```ts
interface KimiCodeToolObligation {
  id: string;
  name: string;
  completed: boolean;
}

function completeToolOnce(
  obligation: KimiCodeToolObligation,
  result: { content: unknown; isError: boolean },
): RuntimeEvent | undefined {
  if (obligation.completed) return undefined;
  obligation.completed = true;
  return {
    type: "tool.completed",
    toolUseId: obligation.id,
    toolName: obligation.name,
    content: result.content,
    isError: result.isError,
    metadata: { provider: KIMI_CODE_PROVIDER_ID },
  };
}
```

- [ ] **Step 4: Verify GREEN and host event-loop compatibility.**

Run: `rtk bun test src/runtime/kimi-code-provider.test.ts src/runtime/host-event-loop.test.ts`

Run: `rtk bun run typecheck`

Expected: both commands exit 0 and every started/completed id is paired.

- [ ] **Step 5: Commit Task 4.**

Run:

```text
rtk git add -- src/runtime/kimi-code-provider.ts src/runtime/kimi-code-provider.test.ts
rtk git commit -m "fix(runtime): pair kimi tool lifecycle events"
```

### Task 5: Make continuity collision-safe and workspace-bound

**Files:**
- Modify: `src/runtime/kimi-code-state.ts`
- Modify: `src/runtime/kimi-code-state.test.ts`
- Modify: `src/runtime/kimi-code-provider.test.ts`

**Interfaces:**
- Adds to state params: `workspaceIdentity` with canonical path and platform identity fields.
- Changes snapshot filename identity from deterministic revision-only naming to immutable collision-safe naming while retaining monotonic `revision` inside the snapshot.

- [ ] **Step 1: Add failing crash and identity regressions.**

Add tests named:

```ts
it("commits after an orphaned next-revision snapshot without overwriting the orphan", async () => {});
it("keeps the previous locator authoritative when promotion aborts", async () => {});
it("rejects resume after the same cwd pathname is retargeted", async () => {});
it("fails closed when canonical workspace identity cannot be established", async () => {});
it("does not expose canonical absolute paths in public provider events", async () => {});
```

Use an isolated real temp directory. On platforms where symlink/junction creation is unavailable, assert the test is explicitly skipped with the platform capability reason rather than silently passing.

- [ ] **Step 2: Run state/provider resume tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts -t "orphaned|promotion aborts|retargeted|workspace identity|canonical absolute"`

Expected: FAIL because revision `N+1` reserves one filename and cwd validation is lexical.

- [ ] **Step 3: Implement immutable snapshot identity and canonical workspace verification.**

Generate filenames such as `revision-${revision}-${randomUUID()}.json`; publish with no-replace semantics, then compare-and-promote only the locator. Persist a bounded identity object derived from canonical realpath plus device/inode when the runtime exposes stable values. On Windows, retain the existing reparse-point checks and fail closed when a stable canonical identity cannot be demonstrated. Resume compares identity, never just the display cwd. Orphans remain unreferenced and cannot block a later revision.

Use the following stored shape and comparison boundary:

```ts
interface KimiCodeWorkspaceIdentity {
  realpath: string;
  device: string;
  inode: string;
}

async function resolveWorkspaceIdentity(cwd: string): Promise<KimiCodeWorkspaceIdentity> {
  const canonical = await realpath(cwd);
  const info = await stat(canonical, { bigint: true });
  if (info.dev < 0n || info.ino <= 0n) throw stateError("workspace identity is unavailable");
  return { realpath: canonical, device: String(info.dev), inode: String(info.ino) };
}
```

Normalize only Windows path casing when comparing `realpath`; compare `device` and `inode` exactly. If the current filesystem exposes an unstable zero inode, fail closed rather than falling back to lexical cwd.

- [ ] **Step 4: Verify GREEN, filesystem safety, and Windows timing.**

Run: `rtk bun test src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts -t "state|resume|orphaned|workspace"`

Run: `rtk bun run typecheck`

Record the slowest Windows ACL test duration. If it exceeds 5 seconds, consolidate ACL application per commit without weakening DACL assertions, then rerun the same tests.

- [ ] **Step 5: Commit Task 5.**

Run:

```text
rtk git add -- src/runtime/kimi-code-state.ts src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-provider.test.ts
rtk git commit -m "fix(runtime): harden kimi session continuity"
```

### Task 6: Clear incompatible model state and gate new sessions

**Files:**
- Create: `src/runtime/kimi-code-availability.ts`
- Create: `src/runtime/kimi-code-availability.test.ts`
- Modify: `src/runtime/kimi-code-provider.ts`
- Modify: `src/runtime/kimi-code-provider.test.ts`
- Modify: `src/runtime/session-resolver.ts`
- Modify: `src/runtime/session-resolver.test.ts`
- Modify: `src/runtime/session-dispatcher.test.ts`

**Interfaces:**
- Produces: `KIMI_CODE_ENABLED_ENV = "RAVI_KIMI_CODE_ENABLED"` and `isKimiCodeSessionStartEnabled(env): boolean`.
- Extends Kimi runtime session params validation with the active model so incompatible Kimi state is cleared before request construction.

- [ ] **Step 1: Add failing availability and model-switch tests.**

Add literal tests proving:

```ts
expect(isKimiCodeSessionStartEnabled({})).toBe(false);
expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "0" })).toBe(false);
expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "true" })).toBe(false);
expect(isKimiCodeSessionStartEnabled({ RAVI_KIMI_CODE_ENABLED: "1" })).toBe(true);
```

Also assert disabled provider remains in registry/catalog, rejects a new session with a fixed non-recoverable availability error before transport creation, and does not delete persisted state. Create a persisted `k3` session, apply restart-next-turn to `k3-256k`, and assert the next request has no old locator/transcript.

Set `RAVI_KIMI_CODE_ENABLED: "1"` in the shared provider request fixture used by unrelated Kimi tests; only the availability tests omit or vary it.

- [ ] **Step 2: Run availability/resolver/dispatcher tests and verify RED.**

Run: `rtk bun test src/runtime/kimi-code-availability.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/session-resolver.test.ts src/runtime/session-dispatcher.test.ts -t "Kimi|kimi|model change|availability"`

Expected: FAIL because no start gate exists and model is absent from stored-session validity.

- [ ] **Step 3: Implement the exact enable flag and model-aware reset.**

The helper returns only `env[KIMI_CODE_ENABLED_ENV] === "1"`. Check it at Kimi `start()` before transport or state mutation. Add the active model to Kimi state validation so `k3` state is stale for `k3-256k`; reuse the resolver's existing stale-clear path. Do not alter the resume rules of Claude, Codex, or Pi.

Implement the availability boundary as:

```ts
export const KIMI_CODE_ENABLED_ENV = "RAVI_KIMI_CODE_ENABLED";

export function isKimiCodeSessionStartEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[KIMI_CODE_ENABLED_ENV] === "1";
}
```

Extend `ValidateRuntimeSessionStateInput` with optional `runtimeProviderId` and `model`; return a new `model_mismatch` reason only when `runtimeProviderId === "kimi-code"`, stored params contain a model, and it differs from the active model.

- [ ] **Step 4: Verify GREEN and existing-provider differential tests.**

Run: `rtk bun test src/runtime/kimi-code-availability.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/session-resolver.test.ts src/runtime/session-dispatcher.test.ts src/runtime/provider-contract.test.ts`

Run: `rtk bun test src/runtime/claude-provider.test.ts src/runtime/codex-provider.test.ts src/runtime/pi-provider.test.ts`

Run: `rtk bun run typecheck`

Expected: commands exit 0; environment-specific executable fixtures may be isolated only after demonstrating they are unchanged baseline failures.

- [ ] **Step 5: Commit Task 6.**

Run:

```text
rtk git add -- src/runtime/kimi-code-availability.ts src/runtime/kimi-code-availability.test.ts src/runtime/kimi-code-provider.ts src/runtime/kimi-code-provider.test.ts src/runtime/session-resolver.ts src/runtime/session-resolver.test.ts src/runtime/session-dispatcher.test.ts
rtk git commit -m "fix(runtime): gate kimi sessions and reset model state"
```

### Task 7: Repair public documentation and executable rollout gates

**Files:**
- Modify: `.ravi/specs/runtime/providers/kimi-code/SPEC.md`
- Modify: `.ravi/specs/runtime/providers/kimi-code/WHY.md`
- Modify: `.ravi/specs/runtime/providers/kimi-code/RUNBOOK.md`
- Modify: `.ravi/specs/runtime/providers/kimi-code/CHECKS.md`
- Modify: `src/runtime/kimi-code-provider.live.test.ts`
- Modify: `docs/superpowers/plans/2026-08-11-kimi-code-provider-hardening.md`

**Interfaces:**
- Documents: the [SPEC](../../../.ravi/specs/runtime/providers/kimi-code/SPEC.md) is the sole normative source for rollout, rollback, and fresh-secret requirements. The [RUNBOOK](../../../.ravi/specs/runtime/providers/kimi-code/RUNBOOK.md) is operational guidance and [CHECKS](../../../.ravi/specs/runtime/providers/kimi-code/CHECKS.md) is the evidence record.
- Preserves: the SPEC's live-test gate; this plan does not redefine it.

- [ ] **Step 1: Reproduce documentation drift and inspect live-test behavior.**

Run the repository documentation link check for the Kimi provider documents.

Expected: matches identify the three broken repository-local references.

Run: `rtk bun test src/runtime/kimi-code-provider.live.test.ts`

Expected: test file exits 0 with live cases explicitly skipped when gates are absent.

- [ ] **Step 2: Replace broken references and make rollout commands exact.**

Replace absent document paths with links to the existing Kimi `SPEC.md`, `WHY.md`, `RUNBOOK.md`, `CHECKS.md`, hardening design, or hardening plan according to ownership. Keep exact rollout behavior solely in the SPEC; the RUNBOOK operationalizes it and design/plan documents link there.

- [ ] **Step 3: Keep release evidence honest.**

Update `CHECKS.md` only with commands actually executed and their final SHA. Leave L-01 through L-04 marked pending until a fresh private credential runs them. The live scaffold requirements are normative in the SPEC and CHECKS records the result.

- [ ] **Step 4: Validate docs, live skip, and secret hygiene.**

Run the repository documentation link check and the credential-hygiene scan for the
Kimi provider scope.

Expected: zero matches.

Run: `rtk bun test src/runtime/kimi-code-provider.live.test.ts`

Run: `rtk git diff --check`

Expected: all commands exit 0, with live cases skipped rather than claimed passed.

- [ ] **Step 5: Commit Task 7.**

Run:

```text
rtk git add -- .ravi/specs/runtime/providers/kimi-code docs/superpowers/plans/2026-08-11-kimi-code-provider-hardening.md src/runtime/kimi-code-provider.live.test.ts
rtk git commit -m "docs(runtime): align kimi rollout gates"
```

### Task 8: Run full verification and independent adversarial review

**Files:**
- Modify only files required by verified Critical or Important review findings.
- Update: `.ravi/specs/runtime/providers/kimi-code/CHECKS.md` with final offline evidence.

**Interfaces:**
- Produces: review-ready PR SHA with complete offline evidence and explicit private-live blocker state.

- [ ] **Step 1: Run all focused Kimi and integration tests.**

Run:

```text
rtk bun test src/runtime/kimi-code-models.test.ts src/runtime/kimi-code-turn.test.ts src/runtime/kimi-code-transport.test.ts src/runtime/kimi-code-state.test.ts src/runtime/kimi-code-availability.test.ts src/runtime/kimi-code-provider.test.ts src/runtime/provider-contract.test.ts src/runtime/model-catalog.test.ts src/runtime/credential-classifier.test.ts src/runtime/credential-store.test.ts src/runtime/session-resolver.test.ts src/runtime/session-dispatcher.test.ts
```

Expected: exit 0 with zero failed tests.

- [ ] **Step 2: Run repository gates from the exact candidate SHA.**

Run:

```text
rtk bun run typecheck
rtk bun run build
rtk bun run test
rtk bun src/cli/index.ts specs get runtime/providers/kimi-code --mode full --json
rtk bun src/cli/index.ts specs get runtime/providers/kimi-code --mode checks --json
rtk powershell -NoProfile -Command "`$env:GITHUB_BASE_REF='dev'; bun src/ci/run-quality-gate.ts"
rtk git diff --check origin/dev...HEAD
```

Expected: every command exits 0. If a harness timeout occurs, rerun the exact underlying package-script groups and record each exit code; do not reinterpret a timeout as PASS.

- [ ] **Step 3: Run public-contribution sanitization.**

Scan `origin/dev...HEAD` for credential-shaped values, the revoked key prefix, `C:\\Users\\`, temporary worktree paths, raw prompts, raw reasoning, and private account data. Inspect every match; expected sensitive matches are zero.

- [ ] **Step 4: Dispatch three independent read-only reviews in parallel.**

Assign one reviewer to protocol/transport, one to lifecycle/tools, and one to state/integration/differential behavior. Each reviewer receives the normative SPEC, hardening design, final diff package, and exact verification report. Critical and Important findings enter one TDD fix wave followed by scoped re-review; no finding is silently discarded.

- [ ] **Step 5: Record final offline evidence and commit only after fresh verification.**

Update `CHECKS.md` with final SHA and exact commands. Keep private live gates pending unless a newly issued secret was used through an approved private channel. Run focused tests, typecheck, build, full tests, both `specs get` commands, the quality gate, diff check, and sanitization again after any review fix.

Run:

```text
rtk git add -- .ravi/specs/runtime/providers/kimi-code/CHECKS.md src/runtime
rtk git commit -m "test(runtime): close kimi hardening regressions"
```

- [ ] **Step 6: Push the candidate and inspect upstream CI without merging.**

Push `feat/kimi-code-provider` to remote `piloto`, confirm PR #406 targets `filipexyz/ravi:dev`, then inspect every check and failure log. CI failures receive a reproducing local test and a TDD correction. Do not merge while L-01 through L-04 remain pending or while any Critical/Important finding is open.
