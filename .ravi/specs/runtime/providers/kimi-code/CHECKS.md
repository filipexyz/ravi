# Kimi Code Provider Checks

All default checks must run without a live Kimi credential. Live tests are opt-in
and must use synthetic prompts.

## Contract checks

- Provider id is stable and additive.
- Capability shape is explicit and conservative.
- `prepareSession`, if present, returns only allowed request/bootstrap fragments.
- Model switch strategy is `restart-next-turn` unless a tested handle proves more.
- Session handle cleanup is idempotent.
- Existing Claude, Codex, and Pi capability snapshots do not change.

Expected upstream gate:

```bash
bun test src/runtime/provider-contract.test.ts
```

## Model and option fixtures

For each model, capture the exact outgoing JSON through an injected fake transport.

| Scenario | Expected |
|---|---|
| K3 + absent user override | catalog resolves exact native `high` |
| K3 + `minimal` or `low` | exact native `low` |
| K3 + `medium` or `high` | exact native `high` |
| K3 + `xhigh`, `max`, or `ultra` | exact native `max` |
| K3 + `none` | deterministic preflight failure |
| fixed-thinking + any canonical effort | no K3-only effort field |
| unsupported explicit effort | deterministic preflight failure |
| unknown model | deterministic catalog failure |
| whitespace/malformed selector | structural validation failure |
| Kimi Code model id matches another provider's priced id | remains unpriced/zero unless a provider-qualified authoritative Kimi Code price exists |

## Streaming fixtures

Create synthetic Server-Sent Events (SSE) fixtures for:

- text deltas followed by usage and completion;
- reasoning and text arriving in separate chunks;
- interleaved text and tool-call argument fragments;
- two tool calls in one assistant message;
- usage arriving in a terminal-only chunk;
- malformed JSON event;
- duplicate terminal marker;
- stream EOF without terminal marker;
- abort while waiting for the next chunk.

Add property/fuzz cases for arbitrary byte fragmentation, split UTF-8 sequences,
unknown additive fields, duplicate chunks, out-of-order tool indices, oversized
events/arguments, and truncated framing. A private redacted wire corpus from the
subscription API must seed at least one golden fixture per model family.

Assert:

- stable delta ordering;
- at most one durable assistant message;
- exactly one terminal canonical event;
- usage recorded at most once;
- transport closed once;
- preserved reasoning absent from public assistant text.
- all permutations of abort, native success, EOF, and transport error resolve to the
  first atomic terminal transition defined by the spec.

## Tool-loop fixtures

1. Single successful tool call.
2. Tool denied by RAVI permission policy.
3. Tool returns structured error.
4. Two independent tool calls returned together.
5. Tool result followed by another tool call.
6. Malformed arguments.
7. Unknown tool name.
8. Tool-loop iteration limit.
9. Two concurrent RAVI sessions emitting tool calls.
10. Duplicate tool-call id before and after host execution begins.
11. Actual SDK outcomes: host `success:true`, host `success:false` for
    permission/unknown tool, and handler exception.

Assert that
calls are serialized, ids are preserved, host authorization runs before execution,
start/completion events pair, and no host tool executes twice.
The concurrent-session fixture must prove that ids, permissions, lifecycle events,
and active-tool state never cross session boundaries.

## Preserved reasoning and continuity

Build a two-request fixture:

1. The assistant emits preserved reasoning and a tool call.
2. RAVI supplies the tool result and requests continuation.

Assert that the complete native assistant message is replayed before the tool
result, while canonical public history contains only intended assistant text.

Then test:

- clean completed-turn resume;
- interruption before terminal state;
- failure before terminal state;
- corrupted state version;
- model mismatch;
- credential/profile mismatch;
- cwd mismatch where the generic contract requires it.

Partial failed/interrupted output must never become committed completed history.

Inject process/transport failure at each boundary: before authorization, after
authorization, before tool execution, after external tool success, before tool
result persistence, before continuation request, after possible provider
acceptance, and before terminal commit. After any tool starts, assert that the
provider performs zero automatic replay without generic host recovery authority.

## Error fixtures

| Fixture | Expected class | Retry |
|---|---|---|
| 401 invalid key | `auth_invalid` / credential | no |
| 401 model/context-tier access | `permission_denied` / request or model | no |
| 402 membership verification | `provider_overloaded` / provider | host only |
| 403 billing-cycle quota | `quota_exhausted` / account | no |
| 403 access terminated | `permission_denied` / account | no |
| 429 engine overloaded | `provider_overloaded` / provider | host only |
| 429 concurrency | `rate_limited` / account | no credential rotation |
| 429 5-hour/monthly quota | `quota_exhausted` / account | no |
| unrecognized 403/429 | `unknown` | no |
| 400 invalid tool schema | `invalid_request` / request | no |
| context overflow | `context_limit` / request | no blind retry |
| malformed SSE or terminal framing | `unknown` + protocol diagnostic | no |
| network/timeout after handoff | `unknown` + ambiguity diagnostic | provider: no |
| 500/502/503 | `network_transient` / provider | provider: no |

User-facing errors must be actionable and redacted. Internal errors may retain a
bounded diagnostic summary without authorization or raw prompt content.

## Negative capability tests

The provider must reject or omit unsupported attachments for:

- image input;
- video input;
- structured output;
- provider-native plugins;
- MCP attachment;
- remote spawn;
- canonical fork;
- parallel tool execution.

These tests prevent documentation-level model features from becoming falsely
advertised RAVI capabilities.

## Regression gates

Run the repository's required checks from the upstream branch:

```bash
bun run build
bun run typecheck
bun run test
bun run sdk:check
bun run check:docs
```

Add focused provider and event-normalizer tests according to the final file layout.
The full provider registry and capability snapshot tests must prove that existing
providers are unchanged.

## Private live release checks

Live checks require explicit operator opt-in and must never run in public CI. They
are nevertheless mandatory before release:

- text streaming against `k3-256k`;
- `max` request capture against `k3` without recording reasoning;
- one harmless synthetic tool call;
- multi-turn continuation;
- abort;
- quota/rate response observation when naturally available.

The release record must identify the upstream SHA, provider model family, redacted
result, date, and operator. It must not retain prompts, reasoning, credential or
account identifiers.

## Public contribution sanitization

Before publishing any issue, PR body, fixture, trace, or attachment:

- remove keys, authorization values, account metadata, hostnames, local paths,
  personal prompts, business data, people data, and provider reasoning;
- replace all examples with synthetic values;
- manually inspect staged changes and commit history;
- verify that no fixture contains a token-shaped opaque string;
- link official docs instead of pasting large excerpts.

Add end-to-end secret sentinels to authorization, prompt text, local path, preserved
reasoning, tool arguments, tool output, provider error body, and exception stack.
After each negative scenario, scan public output, logs, traces, provider state,
fixtures, and snapshots. Every sentinel must be absent from unauthorized sinks.

Pass a managed `KIMI_API_KEY` sentinel through request construction and assert that
it is absent from the dynamic host-tool handler input, child-process environment,
tool result, trace, and every public terminal event. This is mandatory even though
`supportsToolHooks` is false: dynamic host services and provider hooks are separate
SDK mechanisms.
