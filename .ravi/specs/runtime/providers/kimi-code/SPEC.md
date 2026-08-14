---
id: runtime/providers/kimi-code
title: Kimi Code Provider
kind: feature
domain: runtime
capabilities:
  - providers
  - kimi-code
  - streaming
  - reasoning
  - tool-use
  - session-continuity
tags:
  - runtime
  - provider-contract
  - api-adapter
  - kimi
applies_to:
  - src/runtime/kimi-code-provider.ts
  - src/runtime/kimi-code-provider.test.ts
  - src/runtime/kimi-code-transport.ts
  - src/runtime/kimi-code-state.ts
  - src/runtime/kimi-code-models.ts
  - src/runtime/provider-registry.ts
  - src/runtime/provider-contract.test.ts
  - src/runtime/model-catalog.ts
  - src/runtime/credential-classifier.ts
  - src/runtime/credential-store.ts
  - src/costs/pricing-catalog.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Kimi Code Provider

## Intent

RAVI can execute Kimi Code membership models through a first-class provider while
remaining the owner of sessions, routing, permissions, tools, traces, responses,
and durable provider state.

The provider is additive. It does not replace or reinterpret `claude`, `codex`,
`pi`, or Kimi models selected through Pi.

## Scope

The first version covers the Kimi Code membership API through the OpenAI-compatible
base URL `https://api.kimi.com/coding/v1`.

It covers:

- text prompts and streamed text responses;
- the official membership model IDs;
- model-specific reasoning effort normalization;
- serial tool calls routed through RAVI host services;
- host-managed multi-turn provider state;
- interruption, deterministic terminal events, basic usage, and error mapping;
- offline contract tests with an injectable transport.

## Definitions

- **Kimi Code membership API**: the subscription-backed API at
  `api.kimi.com/coding`, distinct from Moonshot Open Platform.
- **Native provider**: a RAVI `RuntimeProvider` that talks directly to the Kimi Code
  API. It does not mean the Kimi Code CLI/runtime is embedded.
- **Provider transcript**: the ordered request history required to continue a
  stateless Chat Completions conversation, including tool and preserved reasoning
  fields required by the wire protocol.
- **Public answer**: canonical assistant text emitted to RAVI consumers. Preserved
  reasoning is not a public answer.
- **K3 effort-controlled family**: `k3` and `k3-256k`, whose native effort domain is
  `low`, `high`, or `max`.
- **Fixed-thinking family**: `kimi-for-coding` and
  `kimi-for-coding-highspeed`, which do not accept a K3 effort override.
- **Server-Sent Events (SSE)**: the streamed HTTP event framing normalized by the
  provider transport.
- **Model Context Protocol (MCP)**: the host attachment capability that remains
  unsupported by this provider in v1.
- **Accepted request**: a request for which the adapter cannot prove that zero bytes
  reached the provider. Failure after this boundary is ambiguous for replay.
- **Replay-safe evidence**: either proof that no request bytes reached the provider
  or an affirmative decision from RAVI's canonical replay policy. Absence of proof
  is not replay-safe evidence.

## Provider Identity

- The stable provider id MUST be `kimi-code`.
- Registration MUST be additive in the runtime provider registry.
- The adapter MUST NOT add provider-specific branches to `bot.ts`, the session
  launcher, the request builder, channel drivers, or task code.
- Durable provider-state lifecycle hooks MUST use a generic host-service and
  executor registry. Provider-specific validation and filesystem cleanup belong
  to the registered provider executor, not to launcher, bot, channel, or task
  branches.
- The adapter MUST identify itself honestly in any client header. It MUST NOT spoof
  Kimi Code CLI, Claude Code, Pi, or another third-party client.

## Service and Credentials

- Production traffic MUST target the Kimi Code membership API family.
- The provider MUST NOT silently fall back to `api.moonshot.ai`.
- A Moonshot Open Platform key MUST NOT be treated as a Kimi Code membership key.
- Credentials MUST enter through the RAVI-owned environment or generic credential
  layer and MUST NOT be stored in SQLite, provider session state, traces, fixtures,
  or error messages.
- The canonical secret target is `KIMI_API_KEY`. A managed runtime credential
  selected by RAVI MUST override an inherited process variable. When no managed
  pool exists, an inherited `KIMI_API_KEY` is accepted only as legacy compatibility.
- `OPENAI_API_KEY`, provider CLI profiles, and Moonshot Open Platform credentials
  MUST NOT be considered implicit Kimi Code credentials.
- Test base URLs MUST be injected through the test transport boundary. Production
  configuration SHOULD NOT expose an arbitrary base URL unless RAVI adopts a
  generic, validated provider endpoint policy.
- All logged headers and request summaries MUST redact authorization values.

## Credential Rotation

- Rotation MAY occur for scheduled replacement, expiry, or suspected exposure; it
  MUST NOT be used to bypass quota, rate limits, or membership windows.
- A replacement credential MUST be newly issued and supplied only through an
  approved private channel. A credential exposed in chat or another public artifact
  MUST NOT be reused.
- The replacement MUST be written to the RAVI secret store or managed credential
  record without entering git, shell history, logs, traces, prompts, screenshots, or
  public reports. Only non-secret credential metadata MAY be verified or recorded.
- Validation of a replacement MUST use exactly one dev-agent canary. The process MUST
  set `RAVI_KIMI_CODE_ENABLED=1` before it starts a new session; all other/default
  agents remain disabled until promotion.
- The previous credential MUST be revoked only after the replacement canary succeeds.
  The release evidence MUST remain redacted.
- If replacement validation fails, new Kimi sessions MUST be disabled before further
  investigation. An exposed previous credential MUST NOT be re-enabled; if exposure
  is suspected it MUST be revoked and Kimi remains disabled until a newly issued
  replacement succeeds.

## Models

The accepted v1 provider MUST expose exactly these four model IDs documented by the
Kimi Code membership API:

- `k3`;
- `k3-256k`;
- `kimi-for-coding`;
- `kimi-for-coding-highspeed`.

Model selectors MUST reject empty values, whitespace, malformed provider prefixes,
and every unknown ID before provider handoff. Later catalog revisions MAY add a
model only through an explicit spec and test update.

The model catalog MUST describe at least:

| Model | Context | Reasoning control | Media input advertised in v1 |
|---|---:|---|---|
| `k3` | up to 1M when entitled | `low`, `high`, `max` | no |
| `k3-256k` | 256K | `low`, `high`, `max` | no |
| `kimi-for-coding` | 256K | fixed thinking | no |
| `kimi-for-coding-highspeed` | 256K | fixed thinking | no |

The adapter MUST NOT infer account entitlement from the configured model. Access
errors belong to provider error mapping.

Pricing MUST be reported only when an authoritative catalog entry exists. Missing
pricing MUST produce unpriced/zero-cost metadata rather than an invented value.

## Reasoning and Thinking

- K3 effort-controlled requests MUST resolve an effort before handoff. If no user
  override exists, the provider-owned catalog default MUST resolve to `high`; the
  adapter MUST NOT rely on an implicit server default.
- Canonical `minimal` and `low` MUST map to native `low`.
- Canonical `medium` and `high` MUST map to native `high`.
- Canonical `xhigh`, `max`, and `ultra` MUST map to native `max`.
- Canonical `none` MUST fail preflight for the K3 effort-controlled family.
- Fixed-thinking models MUST omit the native K3 effort field for every canonical
  effort value. `RuntimeStartRequest` does not carry option provenance, so v1 MUST
  NOT invent a distinction between explicit and inherited effort. Model selection
  documents that K2.7 thinking is fixed.
- Unsupported effort MUST fail clearly before handoff; it MUST NOT silently fall
  back to the server default.
- Preserved reasoning required for a subsequent tool or multi-turn request MUST be
  retained in provider state and replayed in the native assistant message shape.
- Preserved reasoning MUST NOT be copied into canonical assistant text or exposed
  as chain of thought.
- If the current `RuntimeEvent` contract has no reasoning delta, the provider MAY
  emit a bounded `status` signal but MUST keep public output and internal preserved
  reasoning separate.

## Request Assembly

- The adapter MUST consume `RuntimeStartRequest` as its only start contract.
- `systemPromptAppend` MUST be applied according to the provider's declared system
  prompt mode and MUST NOT replace RAVI policy silently.
- Prompt content MUST remain text-only in v1.
- File paths in text MUST NOT be promoted to image or video attachments.
- The adapter MUST enforce the documented 2 MiB message-size boundary using the
  serialized native messages. It MUST NOT pretend to know exact token count without
  a proven tokenizer; provider token/context rejection remains authoritative.
- Request traces MUST contain hashes and metadata, not raw credentials or preserved
  reasoning.

## Transport Interface Profile

- Production requests MUST use `POST` to the provider-owned Chat Completions route
  under the fixed `https://api.kimi.com/coding/v1` base URL.
- Authentication MUST use the documented bearer scheme and MUST be attached only
  after the destination origin passes the membership-API allowlist check.
- Requests MUST use JSON and MUST request streaming for the runtime event path.
- Requests MUST set `stream_options.include_usage` to true and MUST use the stable
  local session UUID as `prompt_cache_key`.
- Production headers are limited to the documented bearer auth scheme, JSON content type,
  `Accept: text/event-stream`, and an honest `User-Agent: ravi/<version>` plus
  headers later proved mandatory by official documentation. The provider MUST NOT
  copy private identity headers from another client.
- Test code MAY replace the transport with an injected fake; request-level or
  user-provided production URL overrides are forbidden.
- The parser MUST accept documented additive unknown fields without changing
  product behavior, but an unknown event shape that prevents deterministic text,
  tool, usage, or terminal interpretation MUST fail as `provider-protocol`.
- SSE line, event, tool-argument, and accumulated-response buffers MUST be bounded
  by provider-local or existing host limits. Limit exhaustion MUST fail explicitly
  and release the transport.
- The documented OpenAI-compatible profile is the implementation baseline. Header,
  terminal, usage, tool-index, cache-key and unknown-field behavior MUST be frozen
  from redacted subscription-API captures before merge or release.

## Streaming and Canonical Events

The adapter MUST normalize transport events into the canonical RAVI event set.

A successful turn MUST emit, in order:

1. `thread.started` when a new provider transcript is created;
2. `turn.started`;
3. zero or more `text.delta`, `status`, and tool lifecycle events;
4. one final `assistant.message` when public assistant text exists;
5. exactly one `turn.complete`.

Failure and interruption paths MUST end in exactly one `turn.failed` or
`turn.interrupted`.

- End-of-stream without a native terminal marker MUST be normalized by the generic
  terminal tracker.
- Repeated or late terminal chunks MUST NOT create a second terminal event.
- Partial tool arguments MUST be buffered and parsed only after the call is
  complete.
- Malformed tool JSON MUST produce a classified failure; the adapter MUST NOT call
  a host tool with partially parsed arguments.
- Usage chunks MAY arrive separately from content but MUST be attached to terminal
  state at most once.
- Native raw events MUST NOT be persisted wholesale. An allowlisted, redacted
  diagnostic projection MAY be retained for observability but MUST NOT become
  product-logic source of truth.

## Turn State Machine

The adapter MUST implement one atomic state machine per turn:

```text
idle
  -> requesting
  -> streaming
  -> awaiting-tool-decision
  -> executing-tool
  -> continuing
  -> streaming
  -> completed | failed | interrupted
```

- `completed`, `failed`, and `interrupted` are terminal and mutually exclusive.
- The first accepted canonical terminal transition wins atomically.
- A local abort observed before committed native success transitions to
  `interrupted`.
- A valid native success committed before a later abort transitions to `completed`.
- Malformed SSE, invalid terminal framing, or EOF without a valid native terminal
  transitions to `failed` with class `provider-protocol`.
- Content, usage, tool, or terminal chunks observed after a terminal transition MUST
  NOT mutate committed state. They MAY contribute only redacted diagnostics.
- No transition to `completed` is permitted while a tool call is incomplete,
  unauthorized, executing, or awaiting a continuation response.
- Cleanup and transport abort MUST be idempotent from every state.

## Tool Loop

- Kimi tool calls MUST route to RAVI dynamic tools/host services.
- The provider MUST NOT execute shell commands or native side effects directly.
- RAVI permission decisions MUST occur before tool execution.
- The adapter MUST call only `RuntimeStartRequest.handleRuntimeToolCall`. The host
  owns lookup, authorization, skill gates, execution timeout and result shaping.
- `tool.started` is the conservative replay-safety fence and MUST be emitted
  immediately before dispatch to the host handler. Every emitted `tool.started`
  MUST have exactly one matching `tool.completed` with the same call id.
- A host result with `success:false`, including unknown tool or authorization
  denial, MUST be appended as the deterministic native tool result using the
  original call id; it MUST NOT execute or redispatch the tool.
- Malformed native arguments that cannot form a host request MUST fail closed
  before `tool.started`.
- A structured host tool error MUST be appended as a tool result and the loop MAY
  continue only when the host marks that result non-terminal.
- The first version MUST advertise parallel tool support as false.
- Multiple calls returned in one model message MUST execute serially in stable
  response order.
- Each tool result MUST be appended with the exact native tool-call id before the
  next model request.
- The adapter MUST retain the complete native assistant tool-call message,
  including preserved reasoning fields required by Kimi, before appending tool
  results.
- Tool-loop iterations MUST be bounded by a configurable or existing host maximum.
  Exhaustion MUST terminate with a classified failure.
- Tool-call ids MUST be deduplicated within the active turn. After any host tool has
  started, the provider MUST NOT replay the turn automatically following an
  ambiguous transport failure.
- Durable reconciliation of a crash after an external side effect is a generic host
  concern and is not added provider-locally in v1. Without host evidence, the turn
  MUST remain failed/ambiguous and require explicit recovery authority.

## Session State and Continuity

The Kimi Chat Completions API is stateless. RAVI therefore owns durable continuity
through one `file-backed` representation.

- Capabilities MUST declare `sessionState: { mode: "file-backed",
  requiresCwdMatch: true }`, `supportsSessionResume: true`, and
  `supportsSessionFork: false`.
- Each logical provider session has a random UUID used as `providerSessionId`,
  `displayId`, and `prompt_cache_key`.
- `RuntimeSessionState.params` MUST contain `schemaVersion`, `provider`, `model`,
  `sessionId`, `revision`, `cwd`, `sessionFile`, and `lastCommittedTurnId`.
- The complete transcript MUST live only in an immutable revision snapshot under
  `getRaviStateDir()/runtime/kimi-code/sessions/<sessionId>/`. It MUST NOT be
  embedded in SQLite session params.
- Provider state MUST contain at least a schema version, provider id, selected
  model, credential-profile fingerprint that contains no secret, required cwd
  identity, committed native messages, and last committed terminal turn identity.
- The transcript MUST include native role, public content, tool-call ids, tool
  results, and preserved reasoning required by the protocol.
- A new snapshot MUST be written to a new revision path with private permissions
  and an atomic temp-file rename. The previous confirmed snapshot MUST never be
  overwritten.
- Before publishing a new immutable snapshot, the adapter MUST durably write a
  private, redacted publish-intent and publish through the generic host lifecycle
  service. Publication and provisional cleanup registration MUST be serialized by
  the host database writer boundary. The new locator MUST be exposed only on
  `turn.complete`; the host then atomically adopts it and consumes that
  reservation through its session-state path. A crash before host persistence
  may leave an unreachable snapshot only when its durable cleanup reservation or
  publish-intent remains recoverable; it MUST never leave an untracked orphan or
  promote partial history.
  `turn.failed` and `turn.interrupted` MUST preserve the previous committed version.
- Interrupted or failed turns MUST NOT commit a partial assistant message as a
  completed history item.
- Resume MUST validate provider id, credential/profile compatibility, model
  compatibility, state version, and working-directory requirements before reuse.
- The adapter MUST NOT claim ambiguous-turn reconciliation unless it can correlate
  one stable client message id against provider-visible state. A stateless API alone
  does not provide that evidence.
- Canonical fork support MUST remain false in v1.
- Model switching MUST use `restart-next-turn` unless a live strategy is proven and
  declared by the runtime handle.
- Transcript persistence MUST follow RAVI's session access and retention policy.
  Preserved reasoning MUST NOT be copied to logs, traces, indexes, or public message
  history.
- Session lifecycle ownership MUST be fenced by an explicit epoch. Metadata-only
  updates MUST NOT invalidate that epoch. Reset, delete, redirect, stale-state
  clear, and provider/model restart MUST use an exact ownership CAS, and a late
  provider callback MUST NOT restore state after ownership changes.
- Removing or superseding a Kimi locator and recording its cleanup obligation
  MUST be one durable SQLite transaction. Cleanup MUST be retryable after process
  crash or transient filesystem failure, and its durable payload MUST contain
  only canonical locator fields—never transcript, reasoning, tool output, raw
  provider errors, or credentials.
- Cleanup execution MUST be idempotent and lease-fenced. Invalid, foreign,
  traversal, snapshot-mismatched, or reparse locators MUST fail closed without a
  filesystem mutation.
- State size MUST be bounded. When state cannot fit the model or host persistence
  limit, the adapter MUST fail with an actionable context/state-limit error unless
  a canonical, tested compaction mechanism preserves native tool/reasoning pairing.

## Capabilities

The first version MUST declare capabilities conservatively:

| Capability | Required v1 declaration |
|---|---|
| text streaming | supported |
| session resume | true in an accepted v1 build |
| canonical fork | false |
| dynamic tools | host services |
| parallel tools | false |
| tool permissions | host service mediated |
| legacy `supportsToolHooks` | false; v1 uses dynamic host services, not provider tool hooks |
| host-session hooks | false |
| plugins | false |
| MCP server attachment | false |
| remote spawn | false |
| multimodal prompt | false |
| structured output | false |
| runtime control | unsupported; mandatory handle `interrupt()` remains available |
| execution | external service through provider-owned HTTP transport |
| terminal events | adapter-enforced |

A capability MUST remain false until its behavior is implemented and covered by a
contract test. Documentation support at the model level is not sufficient if the
RAVI canonical contract cannot carry it.

An accepted v1 build MUST declare resume and interrupt as supported. If either
contract test fails, validation MUST fail and the build MUST NOT ship by silently
downgrading the capability. Capability fields and value domains MUST match the
upstream `RuntimeCapabilities` shape at implementation time; the audited baseline
is SHA `e05e4c9`.

## Errors and Retry Safety

The provider MUST expose redacted native status/body/header fields so RAVI's
generic classifier can classify at least:

| Condition | Classification | Automatic retry |
|---|---|---|
| invalid or missing membership key | `auth_invalid` / credential | no |
| 401 model, context-tier, or HighSpeed entitlement | `permission_denied` / request or model | no |
| 402 membership verification unavailable | `provider_overloaded` / provider | host policy only |
| 403 billing-cycle usage limit | `quota_exhausted` / account | no automatic replay |
| 403 access terminated | `permission_denied` / account | no |
| 429 engine overloaded | `provider_overloaded` / provider | host policy only |
| 429 too many concurrent requests | `rate_limited` / account | no credential rotation |
| 429 5-hour or monthly usage limit | `quota_exhausted` / account | no automatic replay |
| unrecognized 403/429 | `unknown` | no |
| invalid request/tool schema | `invalid_request` / request | no |
| context too large | `context_limit` / request | no blind retry |
| malformed SSE/terminal protocol | `unknown` with protocol detail | no |
| transport timeout/reset after possible acceptance | `unknown` with ambiguity detail | no |
| provider 5xx | `network_transient` or `provider_overloaded` / provider | host policy only |
| local abort | interrupted | no |

- New provider-local error enums MUST NOT compete with
  `RuntimeCredentialFailureKind`. Protocol and ambiguity details stay in redacted
  diagnostics while retry authority remains fail-closed.
- Classification MUST use authoritative provider error code/body semantics before
  generic HTTP status. `Retry-After` controls timing only after classification; it
  MUST NOT decide whether a response is quota or rate limit.
- A 403 or 429 without a recognized authoritative discriminator MUST be `unknown`
  and MUST NOT be retried automatically.
- `Retry-After` and equivalent reset metadata SHOULD be preserved in structured,
  redacted error state.
- User-facing messages MUST distinguish Kimi Code membership API from Moonshot Open
  Platform without exposing keys or raw payloads.
- The adapter MUST NOT rotate credentials or retry an ambiguous side-effecting turn
  independently from RAVI's generic credential and replay policy.

### Retry and replay decision

- The v1 adapter performs zero automatic retry, including before request bytes are
  sent. It reports the failure and lets the canonical host decide.
- After any request byte may have reached the provider, failure is `ambiguous`
  unless replay-safe evidence proves otherwise.
- The provider MUST NOT set `ambiguousTurnRecoveryStrategy`; the stateless endpoint
  cannot reconcile by `clientMessageId`.
- Retry count, backoff, jitter, elapsed-time budget, cooldown, and circuit breaking
  MUST be owned by the canonical host policy, not duplicated in this adapter.

## Usage and Quota

- Input, output, cache-read, and cache-write tokens MUST map to canonical usage when
  present.
- Missing fields MUST remain unavailable rather than inferred.
- Membership windows and remaining quota MUST NOT be estimated from token usage
  unless the API supplies authoritative values.
- Usage MUST be recorded once on terminal state, even if it arrives in a separate
  stream chunk.
- API keys from one membership account MUST be treated as sharing quota. V1 SHOULD
  configure one managed credential per membership account because the current pool
  has no account-group health boundary.
- `quota_exhausted` without authoritative reset metadata MUST remain exhausted
  until operator action or successful preflight; the generic 24-hour fallback is
  unsafe for weekly/monthly Kimi windows and MUST be corrected before enablement.
- The provider MUST NOT rotate keys or open another key to bypass a quota window.
- Quota coordination across agents/accounts belongs to a generic RAVI admission and
  cooldown layer. Until such a layer is proven, quota and unknown-limit outcomes
  fail closed and block provider-local automatic retry.

## Security and Privacy

- No credential, authorization header, preserved reasoning, raw media, or complete
  prompt body may appear in public fixtures.
- Provider raw traces MUST be redacted before persistence or display.
- The adapter MUST use synthetic fixtures for tests and PR evidence.
- Request errors MUST sanitize credential-shaped values, local paths, and transport
  internals in user-facing output.
- A live smoke test MUST be opt-in and excluded from default CI.

## Compatibility

- Existing provider IDs and model selectors MUST keep their behavior.
- Existing `pi` selectors such as `kimi-coding/<model>` MUST remain valid.
- Selecting `kimi-code` MUST be explicit; there is no automatic migration from Pi.
- Removing the new registry entry and provider-local files MUST be sufficient to
  roll back the feature without schema rollback or migration of other providers.

## Non-Goals

- Kimi Code CLI/runtime embedding.
- Moonshot Open Platform pay-as-you-go support.
- Media input or media generation.
- Chain-of-thought display.
- Parallel tool execution.
- Canonical forks or ambiguous-turn reconciliation.
- Provider-native plugins, MCP, browser/search, swarm, hooks, or remote spawn.
- Hidden model fallback or hidden credential rotation.

## Release Gates

- The hardening design records the planning questions that informed this contract;
  it does not replace this normative release gate.
- `RAVI_KIMI_CODE_ENABLED=1` is the only setting that enables a new `kimi-code`
  session. Removing the variable, or setting it to any other value, disables new
  sessions when they are started. Registration and model discovery remain
  available while disabled.
- Disabling new sessions MUST preserve existing Kimi provider state. It MUST NOT
  delete, translate, or migrate that state.
- Upstream runtime/provider contracts MUST be revalidated before the implementation
  plan is finalized and again before the public pull request is opened.
- Redacted subscription-API captures MUST validate text, tool, reasoning, usage,
  terminal, abort, and error fixtures without entering public history.
- Offline contract, fuzz, crash-boundary, redaction, and regression checks MUST pass.
- A private live smoke is mandatory for release even though it MUST remain outside
  public CI. It requires both `RAVI_LIVE_TESTS=1` and a newly issued
  `KIMI_API_KEY` supplied through an approved private channel; a credential exposed
  in chat or another public artifact MUST NOT be used.
- Rollout MUST start with one explicit dev-agent canary and a kill switch for new
  sessions. Existing providers MUST remain the default until promotion criteria pass.
- Any duplicate/missing terminal, duplicate tool execution, secret/reasoning leak,
  unsafe replay, or misclassified quota observed in canary MUST block promotion.

## Acceptance Criteria

- **KC-AC-01:** `kimi-code` is discoverable as a built-in provider without changing existing
  provider behavior.
- **KC-AC-02:** All four official Kimi Code model IDs pass structural/catalog validation.
- **KC-AC-03:** Every canonical K3 effort mapping is present exactly in captured request fixtures.
- **KC-AC-04:** Fixed-thinking requests omit K3-only reasoning fields for every canonical
  effort value, because the current start request does not preserve effort provenance.
- **KC-AC-05:** An interleaved SSE fixture produces stable text, tool, usage, and exactly one
  terminal event.
- **KC-AC-06:** A tool call is authorized through RAVI, executed once, returned with its native
  id, and followed by a final assistant answer.
- **KC-AC-07:** Two tool calls in one response execute serially and preserve order.
- **KC-AC-08:** Preserved reasoning is replayed in the native assistant history but absent from
  canonical public assistant text.
- **KC-AC-09:** Resume reconstructs the next request from committed provider state without
  replaying an interrupted assistant message.
- **KC-AC-10:** Abort yields one `turn.interrupted` and closes the transport idempotently.
- **KC-AC-11:** Synthetic 401, 403, 429, context, malformed request, timeout, 5xx, and truncated
  stream fixtures map to the declared classifications.
- **KC-AC-12:** Contract, provider, build, typecheck, and documentation checks pass without a
  live Kimi credential.
- **KC-AC-13:** Multimodal, fork, parallel tools, plugins, MCP, and remote spawn remain declared
  unsupported.
- **KC-AC-14:** Crash-boundary tests prove no automatic replay after a host tool begins.
- **KC-AC-15:** Private live smoke and dev-agent canary satisfy every release gate.

## Known Failure Modes

- A truncated SSE stream leaves a turn active without a terminal event.
- Tool-call arguments are executed before the final JSON fragment arrives.
- `reasoning_content` is dropped before the following tool-result request.
- `max` is omitted and silently becomes the service default.
- A fixed-thinking model receives a K3-only effort field.
- An interrupted partial assistant message is persisted and duplicated on resume.
- Multiple tool calls corrupt host active-tool state because they were not
  serialized.
- A Kimi Code key is sent to the Moonshot Open Platform endpoint or vice versa.
- Quota exhaustion is classified as a generic permission failure and retried.
- The adapter claims image/video support because the model supports media input,
  although RAVI still passes only strings.
- The adapter spoofs another client identity to satisfy an undocumented behavior.

## Validation

The requirements in this document are normative. [`CHECKS.md`](CHECKS.md) records
validation commands and evidence; [`RUNBOOK.md`](RUNBOOK.md) is operational guidance
aligned to these requirements. Rationale and rejected alternatives are in
[`WHY.md`](WHY.md). The hardening design and plan are
[linked from the design](../../../../../docs/superpowers/specs/2026-08-11-kimi-code-provider-hardening-design.md)
and [implementation plan](../../../../../docs/superpowers/plans/2026-08-11-kimi-code-provider-hardening.md);
they refine implementation only.
