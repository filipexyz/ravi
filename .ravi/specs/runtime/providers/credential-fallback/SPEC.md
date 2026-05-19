---
id: runtime/providers/credential-fallback
title: "Runtime Provider Credential Fallback"
kind: feature
domain: runtime
capabilities:
  - providers
  - credentials
  - fallback
  - rate-limits
tags:
  - runtime
  - provider-contract
  - credentials
  - rate-limits
  - claude-code
  - codex
  - pi
applies_to:
  - src/runtime/types.ts
  - src/runtime/provider-registry.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/runtime-request-context.ts
  - src/runtime/runtime-provider-bootstrap.ts
  - src/runtime/host-env.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/claude-provider.ts
  - src/runtime/codex-provider.ts
  - src/runtime/pi-provider.ts
  - src/router/router-db.ts
  - src/cli/commands/settings.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Runtime Provider Credential Fallback

## Intent

Ravi must support multiple credentials per runtime provider and automatically choose another eligible credential when the current one is rate limited, quota exhausted, billing blocked, or otherwise unusable for the requested model. The feature exists to keep long-running sessions, task workers, and interactive chats alive without scattering provider-specific retry logic through the runtime host.

Credential fallback is a runtime/provider concern. Routes, sessions, tasks, channels, and agents continue to select a runtime provider and model; the credential resolver selects the concrete credential slot used for each provider attempt.

## Current Reality

- `claude` passes a provider env into the Claude Code SDK query. Ravi primarily uses Claude Code subscription/OAuth credentials through `CLAUDE_CODE_OAUTH_TOKEN`. `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, cloud-provider env, and `apiKeyHelper` are secondary/specialized auth methods for Anthropic API, enterprise/cloud, or explicit operator configuration.
- `codex` runs a subprocess app-server. Codex authentication can be cached under `CODEX_HOME` or OS credential storage. Custom Codex model providers may also rely on an `env_key`, but Ravi's current app-server env signature only treats `RAVI_*`, `CODEX_HOME`, and `PATH` as process-restart inputs.
- `pi` runs a subprocess RPC and passes `input.env` into the Pi process. Pi model selectors are `provider/model`, with a default upstream provider from `RAVI_PI_PROVIDER`, `PI_PROVIDER`, or `openai`.
- No provider currently emits a canonical credential failure shape. Failures become generic `turn.failed` strings plus optional raw provider payloads.
- No runtime table exists for provider credential pools, health, cooldowns, or attempt history.

## Terminology

- **Runtime provider**: Ravi adapter id such as `claude`, `codex`, or `pi`.
- **Upstream provider**: Provider behind a runtime adapter, such as `anthropic`, `openai`, `google`, `openrouter`, `groq`, or `kimi-coding`.
- **Credential pool**: Ordered set of credentials eligible for a runtime provider, upstream provider, model family, agent, or task scope.
- **Credential slot**: One configured credential entry with metadata, secret bindings, state, and health.
- **Secret reference**: A pointer to a secret value. Ravi metadata stores the reference, not the raw secret.
- **Secret binding**: A mapping from one secret reference to the provider-facing destination that will receive it during an attempt.
- **Attempt binding**: The in-memory, redacted runtime binding produced by resolving a credential slot for one provider attempt.
- **Attempt**: One model turn using one credential slot.

## Credential Metadata

Ravi MUST model provider credentials as metadata plus explicit secret bindings:

```ts
interface RuntimeCredential {
  id: string;
  label: string;
  runtimeProvider: "claude" | "codex" | "pi" | string;
  upstreamProvider?: string;
  modelAllowlist?: string[];
  modelDenylist?: string[];
  agentAllowlist?: string[];
  taskProfileAllowlist?: string[];
  priority: number;
  weight?: number;
  enabled: boolean;
  status: "healthy" | "cooldown" | "exhausted" | "invalid" | "disabled" | "unknown";
  authMethod?: string;
  sessionCompatibilityKey?: string;
  secretBindings: RuntimeCredentialSecretBinding[];
  authProfileRef?: string;
  sensitiveEnvKeys?: string[];
  remoteForwardEnvKeys?: string[];
  notes?: string;
  createdAt: number;
  updatedAt: number;
}

interface RuntimeCredentialSecretBinding {
  id?: string;
  targetKind: "env" | "auth-profile" | "provider-config";
  targetName: string;
  secretRef: RuntimeSecretRef;
  sourceHint?: string;
  sensitive?: boolean;
  remoteForward?: boolean;
}
```

`RuntimeCredential` is persisted metadata and MUST NOT contain resolved provider env with secret values. Secret values MUST only appear in memory inside an attempt binding after resolving `secretBindings`.

Credentials that require multiple secret values MUST use multiple `secretBindings` under the same `RuntimeCredential`. This is required for cloud/provider composite credentials such as Bedrock, Vertex, Azure/OpenAI, Codex custom provider env keys, or any provider that needs account id plus token plus region/project metadata. Ravi MUST NOT collapse these into a single opaque `env` object in persisted storage.

`secretBindings[].secretRef` MUST NOT contain the secret value in SQLite. Supported reference kinds SHOULD be:

- `env:NAME` for existing process environment variables.
- `exec:/path/to/helper` for a helper that prints one credential value to stdout.
- `keychain:<service>/<account>` for OS credential stores.
- `file:/path` for provider-owned auth profile files or directories such as `CODEX_HOME`, not for raw API keys unless the file is explicitly managed as a secret file.
- `ravi-secret:<id>` for a future Ravi secret store.

If a CLI accepts a raw secret value, it MUST store it in a secret backend and write only secret binding/ref metadata to the router database. A plaintext local file fallback MUST require explicit operator opt-in, file mode `0600`, and redacted CLI output.

## Storage

The implementation SHOULD add first-class storage instead of overloading `settings`:

- `runtime_credential_pools`: pool id, runtime provider, upstream provider, model selector filters, policy, created/updated timestamps.
- `runtime_credentials`: metadata, priority/weight, enabled/status, auth method, session compatibility key, redacted fingerprint.
- `runtime_credential_secret_bindings`: credential id, target kind/name, secret ref, source hint, redaction/sensitivity metadata.
- `runtime_credential_health`: credential id, last success/failure, last limit signal, cooldown until, reset at, consecutive failures, counters.
- `runtime_credential_attempts`: attempt id, session key/name, run id, turn id, provider, model, credential id, status, classifier result, started/completed timestamps.

`settings` MAY keep feature flags or default policy knobs, but credential records MUST be queryable without parsing unrelated setting keys.

## Selection

Before a provider attempt starts, the runtime host MUST call a credential resolver with:

- runtime provider id
- upstream provider id when known
- model selector
- agent id
- session key/name
- task profile and task id when present
- requested effort/thinking
- current timestamp

The resolver MUST:

- filter disabled, invalid, exhausted, or cooldown credentials unless an explicit force option is used;
- filter by runtime provider, upstream provider, model allow/deny lists, agent allow lists, and task profile allow lists;
- prefer higher priority, then lower active concurrency, then older `lastUsedAt`, then deterministic id order;
- atomically reserve a slot for the attempt to avoid every concurrent turn choosing the same credential after a limit event;
- resolve secret bindings into an in-memory attempt binding;
- return a redacted credential attempt binding with `credentialId`, `label`, `fingerprint`, `resolvedEnv`, `authProfileRef`, `sensitiveEnvKeys`, `remoteForwardEnvKeys`, `authMethod`, and `sessionCompatibilityKey`.

`resolvedEnv` MUST NOT be persisted, logged, traced, or emitted. It is provider-facing attempt state only.

The resolver MAY implement weighted round-robin after priority filtering. It MUST be deterministic enough for tests and incident review.

If no credential is configured for a provider, Ravi MUST keep current behavior and use the process/provider default auth path. Fallback becomes active only when a pool exists or an agent/session explicitly opts into credential management.

## Provider Session Continuity

Provider session ids, runtime session params, thread ids, and fork/resume state MUST be scoped to the credential that created them.

When a managed credential is selected, Ravi MUST persist redacted credential continuity metadata alongside provider session state:

- `runtimeProvider`
- `credentialId`
- `credentialFingerprint`
- `sessionCompatibilityKey`
- `authMethod`
- `upstreamProvider`
- `model`
- timestamp of last successful turn

`authMethod` and `sessionCompatibilityKey` MAY be persisted operator metadata or derived by provider-local credential binding code. When derived, the derivation MUST be deterministic from non-secret metadata such as credential id, auth profile ref, target provider, or an operator-defined account id.

`sessionCompatibilityKey` MUST be stable for a provider account/profile boundary but MUST NOT reveal the secret. Good examples include a hash of the credential id plus auth profile ref, a Codex profile id, or an operator-defined account id. Raw API keys, OAuth tokens, and auth file contents MUST NOT be stored in runtime session params.

Ravi MUST resume or fork a provider session only when the stored runtime provider and selected credential session compatibility metadata match. If fallback selects a different credential, the next attempt MUST start without `resume`, `resumeSession`, or `forkSession` unless that provider explicitly declares sessions are account-independent for the selected auth method.

This is required because Claude Code, Codex, and upstream model providers may bind thread/session ids to the authenticated account. Retrying a turn on another credential while reusing the previous provider session can fail, leak state across accounts, or corrupt local session continuity.

## Environment Injection

Credential injection MUST happen in the generic runtime request-building layer, after runtime/model resolution and before the provider starts the native process/query.

Provider bootstrap env and credential env MUST be merged explicitly:

1. sanitized process env
2. provider bootstrap env
3. credential env
4. Ravi runtime env

Credential env wins over provider bootstrap defaults. Ravi runtime env wins only for `RAVI_*` context variables and MUST NOT be used for provider API secrets.

Providers MUST NOT hardcode provider ids in the host. Provider-specific env mapping belongs in a credential binding registry or provider-local adapter code.

Every credential binding that touches env MUST identify both the source secret name and the provider-facing target env name as sensitive. Runtime env sanitization, bash/tool hooks, trace redaction, provider raw summaries, and remote spawn forwarding MUST use the static sensitive key set plus the selected credential's dynamic sensitive env keys. Examples such as `CLAUDE_CODE_OAUTH_TOKEN_1`, `ANTHROPIC_API_KEY_1`, `OPENAI_API_KEY_WORK`, `OPENAI_API_KEY`, or provider-specific `env_key` values MUST be treated as secrets even though they are not in Ravi's static sanitizer list.

For providers without Ravi-hosted tool hooks, credential env MUST NOT be injected unless the provider has a separate model-secret channel that cannot be observed by tools. Removing known secret keys after env merge is safer than passing secrets into a process that owns unrestricted tool execution.

Credential env mapping MUST distinguish source secret storage from provider-facing destination. For example, a CLI input such as `--secret-env CLAUDE_CODE_OAUTH_TOKEN_1 --target-env CLAUDE_CODE_OAUTH_TOKEN` means Ravi reads the secret from `env:CLAUDE_CODE_OAUTH_TOKEN_1`, then injects it into the provider attempt as `CLAUDE_CODE_OAUTH_TOKEN`. The source env name and target env name are allowed to differ. Provider examples MAY infer the target env from `--auth-method`, but the stored secret binding MUST still make the mapping explicit. Repeated source/target pairs MUST be supported for composite credentials.

### Claude

Claude credential slots MAY map to:

- `CLAUDE_CODE_OAUTH_TOKEN`
- `ANTHROPIC_API_KEY`
- `ANTHROPIC_AUTH_TOKEN`
- cloud-provider credentials for Bedrock, Vertex, or Foundry
- an `apiKeyHelper` profile

For runtime provider `claude`, Ravi SHOULD prefer `CLAUDE_CODE_OAUTH_TOKEN` slots by default because Claude Code usage in Ravi is primarily subscription/OAuth-based. `ANTHROPIC_API_KEY` slots MUST be opt-in, lower default priority, or scoped to agents/models that explicitly require direct Anthropic API key behavior.

Claude managed credential binding MUST be auth-method exclusive. When selecting an OAuth slot, Ravi MUST remove conflicting Claude auth env such as `ANTHROPIC_API_KEY` and `ANTHROPIC_AUTH_TOKEN` from the provider env unless the credential binding explicitly declares a multi-auth method. When selecting an API-key/token/cloud slot, Ravi MUST similarly avoid carrying a process-level `CLAUDE_CODE_OAUTH_TOKEN` unless that method is intentional. This prevents the sanitized process env from accidentally overriding the selected credential.

Ravi MUST record the selected Claude auth method in redacted attempt metadata.

Claude remote execution MUST be credential-aware. SSH/NATS remote spawn boundaries MUST forward only the selected credential binding's allowed `remoteForwardEnvKeys`. If a selected Claude credential uses `ANTHROPIC_AUTH_TOKEN`, cloud-provider credentials, or `apiKeyHelper`, the remote spawn implementation MUST either support that auth method explicitly or mark the credential ineligible for remote agents.

### Codex

Codex credential slots have two separate shapes:

- **Codex account profile**: `CODEX_HOME` or OS credential profile containing Codex login/auth cache.
- **API/custom provider env**: an env var such as `OPENAI_API_KEY` used by Codex or a Codex custom model provider.

When Codex credentials alter process env or `CODEX_HOME`, the app-server transport MUST respawn before the next attempt. The env signature MUST include selected credential env keys and auth profile refs, but shell tool env allowlists MUST continue excluding provider secret variables unless explicitly required by a provider integration.

Codex provider session continuity MUST include the selected account profile or credential session compatibility key. Ravi MUST NOT resume a Codex thread created under one `CODEX_HOME` or account profile after selecting another profile.

### Pi

Pi credential slots MUST match both Ravi runtime provider `pi` and the Pi upstream provider selected from `provider/model` or default provider env.

Pi currently receives provider env in the same subprocess that owns provider-native tools. Before enabling secret injection for Pi, Ravi MUST verify that provider API secrets are not exposed to tool commands, logs, or session artifacts. If Pi cannot separate model-provider secrets from tool execution env, Ravi MUST prefer provider profile/helper references or disable automatic Pi secret injection for unrestricted tool sessions.

## Failure Classification

Providers MUST normalize native failures into a canonical credential signal when possible:

```ts
interface RuntimeCredentialFailureSignal {
  kind:
    | "rate_limited"
    | "quota_exhausted"
    | "billing_blocked"
    | "auth_invalid"
    | "permission_denied"
    | "provider_overloaded"
    | "network_transient"
    | "context_limit"
    | "invalid_request"
    | "unknown";
  confidence: "high" | "medium" | "low";
  runtimeProvider: string;
  upstreamProvider?: string;
  model?: string;
  credentialId?: string;
  httpStatus?: number;
  providerCode?: string;
  providerType?: string;
  message?: string;
  retryAfterMs?: number;
  resetAt?: number;
  requestId?: string;
  rawHeaders?: Record<string, string>;
  scope?: "credential" | "account" | "project" | "organization" | "model" | "provider" | "request" | "unknown";
  retryableByCredential?: boolean;
  source: "http" | "sdk-error" | "cli-event" | "stderr" | "rpc-error" | "heuristic";
}
```

Classifiers MUST prefer structured provider data over string matching. Heuristics over stderr or free-form messages MUST set `confidence` to `low` or `medium` unless the provider has a stable documented message.

## Provider Detection Matrix

### OpenAI

Treat these as credential/provider limit signals:

- HTTP `429` or SDK `RateLimitError` -> `rate_limited`.
- Error text/code indicating current quota, credits, or monthly spend exceeded -> `quota_exhausted` or `billing_blocked`.
- HTTP `401` or SDK authentication error -> `auth_invalid`.
- HTTP `403` or permission denied -> `permission_denied`; retry only when structured data proves the denial is credential/account-specific.
- HTTP `500`/`503` -> `provider_overloaded` or `network_transient`, not credential exhaustion.

When available, capture `x-ratelimit-limit-requests`, `x-ratelimit-limit-tokens`, `x-ratelimit-remaining-requests`, `x-ratelimit-remaining-tokens`, `x-ratelimit-reset-requests`, `x-ratelimit-reset-tokens`, `x-request-id`, and `Retry-After`.

### Anthropic and Claude Code

Treat these as credential/provider limit signals:

- HTTP `429` with error type `rate_limit_error` -> `rate_limited`.
- HTTP `402` with `billing_error` -> `billing_blocked`.
- HTTP `401` with `authentication_error` -> `auth_invalid`.
- HTTP `403` with `permission_error` -> `permission_denied`.
- HTTP `529` with `overloaded_error` -> `provider_overloaded`, not credential exhaustion.

Capture `retry-after`, `request-id`, `anthropic-ratelimit-requests-*`, `anthropic-ratelimit-tokens-*`, `anthropic-ratelimit-input-tokens-*`, and `anthropic-ratelimit-output-tokens-*` headers when the SDK or CLI exposes them.

Claude Code CLI/SDK may surface subscription or OAuth usage limits as result errors or exceptions rather than raw HTTP. The adapter MUST preserve enough native error detail to classify those cases without leaking credentials.

### Google Gemini and Vertex AI

Treat these as credential/provider limit signals:

- HTTP/gRPC `429 RESOURCE_EXHAUSTED` -> `rate_limited` when it represents quota or project capacity, with `confidence` based on structured quota details.
- `google.rpc.QuotaFailure` details -> `quota_exhausted` or `rate_limited` depending on whether reset/retry data exists.
- `RetryInfo` details or `Retry-After` -> cooldown.
- HTTP/gRPC `503 UNAVAILABLE` -> `provider_overloaded` or `network_transient`.

For Vertex AI pay-as-you-go, some `429` responses mean shared capacity is unavailable rather than a specific key being exhausted. Ravi MUST avoid marking a credential `exhausted` unless structured details identify a quota, project, account, or key-specific limit.

### OpenRouter

Treat these as credential/provider limit signals:

- HTTP `401` -> `auth_invalid`.
- HTTP `402` -> `billing_blocked` or `quota_exhausted` due to insufficient credits.
- HTTP `429` -> `rate_limited`.
- HTTP `503` with `Retry-After` -> `provider_overloaded`.

Capture `Retry-After` when present.

### Groq

Treat HTTP `429` as `rate_limited` and capture:

- `retry-after`
- `x-ratelimit-limit-requests`
- `x-ratelimit-limit-tokens`
- `x-ratelimit-remaining-requests`
- `x-ratelimit-remaining-tokens`
- `x-ratelimit-reset-requests`
- `x-ratelimit-reset-tokens`

Groq headers use different limiter semantics than OpenAI: requests headers can refer to RPD while token headers refer to TPM. Ravi MUST store the raw limiter dimension instead of assuming one universal period.

### Codex

Codex fallback MUST distinguish:

- app-server process/account profile failures;
- OpenAI API key failures;
- custom model provider failures.

The adapter MUST preserve `turn.failed`, app-server error events, JSON-RPC errors, stderr, model provider, model, thread id, and request/turn ids in a redacted failure payload.

Automatic Codex credential rotation is allowed only when the classifier has at least `medium` confidence that the failure is auth, quota, billing, or rate-limit related. Unknown app-server errors MUST NOT trigger account rotation.

### Pi

Pi fallback MUST use upstream provider data from Pi events or RPC responses. The Pi adapter MUST preserve, when available:

- upstream provider id
- model id
- API surface
- HTTP status
- provider error type/code
- provider message
- retry headers
- request id

If Pi only returns `stopReason=error` plus free-form `errorMessage`, Ravi MAY classify by heuristic, but MUST mark confidence low and SHOULD surface a spec gap for Pi RPC error envelopes.

## Retry Policy

Automatic fallback MUST be safe by default.

Automatic fallback MUST be orchestrated before a provider failure becomes a user-visible terminal response. The attempt orchestrator MUST own the current Ravi turn, selected credential binding, attempt number, and retry decision.

Because `RuntimeStartRequest.prompt` is an async generator, the implementation MUST materialize the current pending `RuntimePromptMessage` into an immutable, replayable attempt input before starting a managed credential attempt. Retrying MUST replay that in-memory attempt input, not read another message from the live generator, and MUST NOT append another durable user message.

Each credential retry MUST start a fresh provider attempt boundary with a new selected credential. If the provider session handle cannot safely swap credentials, the old handle MUST be closed and a new handle started. Resume/fork state MUST be recalculated through the provider session continuity rules above.

The runtime host MAY retry the same user turn with another credential only when:

- the failure classifier kind is `rate_limited`, `quota_exhausted`, `billing_blocked`, `auth_invalid`, or `permission_denied`;
- the classifier has `retryableByCredential !== false`;
- the classifier scope is `credential`, `account`, `project`, `organization`, or `unknown` with at least medium confidence;
- another eligible credential exists;
- the turn has not emitted a host-observed `tool.started` event;
- the session was not explicitly interrupted by the user;
- max attempts for the turn have not been reached;
- the new credential is not already in cooldown or invalid state.

The runtime host MUST NOT automatically re-run a turn after any provider tool started unless a future idempotency contract proves tool side effects are safe to replay.

Provider overload and network transient failures SHOULD use normal retry/backoff policy, not credential exhaustion marking, unless provider data proves the credential/account is the constrained resource.

Default limits:

- `maxCredentialAttemptsPerTurn`: 3
- `maxCredentialAttemptsPerPool`: number of eligible enabled credentials
- `defaultRateLimitCooldownMs`: from `Retry-After` or reset header when present, otherwise 60 seconds
- `quotaExhaustedCooldownMs`: operator configured, default until next day boundary or manual reset
- `authInvalidCooldownMs`: no automatic retry for same credential until manual re-enable or successful preflight

Retry attempts MUST NOT duplicate durable user messages. They are trace attempts for one Ravi turn, not new chat messages.

## Health State Transitions

- Success moves a credential toward `healthy`, clears transient failure counters, and records last success.
- `rate_limited` sets `cooldown` until `retryAfterMs` or `resetAt`.
- `quota_exhausted` sets `exhausted` or long cooldown depending on provider details.
- `billing_blocked` sets `exhausted` until operator action.
- `auth_invalid` sets `invalid` until operator action or successful preflight.
- `permission_denied` sets `invalid` for the specific credential/model/scope only when provider data proves the denial is tied to that credential. Request, safety, region, or provider-policy permission failures MUST NOT disable the credential globally.
- `provider_overloaded`, `network_transient`, `context_limit`, `invalid_request`, and `unknown` MUST NOT mark the credential exhausted.

Health updates MUST be atomic and traceable. Manual overrides MUST record actor, reason, and timestamp.

## Observability

Ravi MUST emit and trace credential fallback events with redacted metadata:

- `runtime.credential.selected`
- `runtime.credential.failure_classified`
- `runtime.credential.cooldown_started`
- `runtime.credential.retry_scheduled`
- `runtime.credential.exhausted`
- `runtime.credential.recovered`
- `runtime.credential.pool_empty`

Event payloads MUST include credential id, label, fingerprint, provider, upstream provider, model, attempt number, classifier kind, confidence, cooldown/reset timestamps, and request id when available. Event payloads MUST NOT include raw secret values.

`turn.failed` user-facing messages SHOULD summarize provider availability without exposing internal credential labels unless the caller has admin permissions.

## CLI Surface

Ravi SHOULD expose provider credential management under `ravi runtime credentials` to avoid colliding with `ravi context credentials`.

Minimum commands:

- `ravi runtime credentials list`
- `ravi runtime credentials add`
- `ravi runtime credentials disable`
- `ravi runtime credentials enable`
- `ravi runtime credentials remove`
- `ravi runtime credentials status`
- `ravi runtime credentials test`
- `ravi runtime credentials reset-health`

Recommended add examples:

```bash
ravi runtime credentials add --provider claude --upstream anthropic --label claude-oauth-1 --auth-method claude-oauth --secret-env CLAUDE_CODE_OAUTH_TOKEN_1 --target-env CLAUDE_CODE_OAUTH_TOKEN
ravi runtime credentials add --provider pi --upstream openai --label openai-2 --secret-env OPENAI_API_KEY_2 --target-env OPENAI_API_KEY --models openai/gpt-5.5
ravi runtime credentials add --provider claude --upstream bedrock --label bedrock-prod --secret-env AWS_ACCESS_KEY_ID_RAVI --target-env AWS_ACCESS_KEY_ID --secret-env AWS_SECRET_ACCESS_KEY_RAVI --target-env AWS_SECRET_ACCESS_KEY --secret-env AWS_SESSION_TOKEN_RAVI --target-env AWS_SESSION_TOKEN
ravi runtime credentials add --provider codex --label codex-profile-2 --auth-profile ~/.codex-profiles/profile-2
```

For env-backed secrets, each `--secret-env` MUST pair with one `--target-env`. The CLI MUST reject unmatched, duplicated, or order-ambiguous pairs. Each pair creates one `targetKind: "env"` secret binding. Non-env-backed credentials SHOULD use provider-specific flags such as `--auth-profile` or an explicit structured binding flag rather than overloading env syntax.

JSON output MUST redact secrets and include enough health data for automation.

## Security

- Secrets MUST never be written to traces, logs, events, cost rows, session params, task artifacts, or provider raw summaries.
- Credential fingerprints MUST be irreversible hashes over stable non-secret metadata or secret digests computed without revealing the value.
- Provider secret env MUST NOT be inherited by shell tools unless a provider requires it and the agent has explicit unrestricted access.
- Codex shell env allowlists MUST keep provider secret env names out of model-run shell tools by default.
- Bash/tool sanitizers MUST include dynamic `sensitiveEnvKeys` from the selected credential binding in addition to the built-in sanitizer list.
- Legacy provider event topics MUST receive redacted/summarized provider payloads only. Raw failure payloads that may contain headers, env, command args, or auth diagnostics MUST be redacted before any `safeEmit`.
- Pi secret injection MUST not be enabled for unrestricted provider-native tool execution until the env/tool leakage risk is resolved.
- Operators MUST be able to disable a credential immediately.
- Failed auth/permission attempts MUST avoid tight retry loops.
- Management commands MUST require admin/runtime credentials permissions.

## Implementation Plan

1. Add canonical types for credential bindings, failure signals, classifier results, health transitions, session compatibility, dynamic sensitive env keys, and redacted trace payloads.
2. Add provider failure classifiers with fixture tests for OpenAI, Anthropic, Google/Vertex, OpenRouter, Groq, Codex app-server, and Pi RPC.
3. Add SQLite metadata tables and CLI management commands under `ravi runtime credentials`.
4. Add credential secret binding resolution, env/profile injection, and dynamic secret sanitizer inputs into `buildRuntimeStartRequest`.
5. Add provider session continuity checks before `resume`, `resumeSession`, or `forkSession`.
6. Extend provider adapters to attach selected credential metadata to events and expose structured failure signals.
7. Add safe credential attempt orchestration before user-visible terminal failure emission, with no automatic replay after tool start.
8. Add Claude remote-spawn credential forwarding rules and Codex app-server respawn rules.
9. Add status/preflight checks and operational runbook.

## Validation

- Classifier fixtures MUST cover each provider detection matrix entry.
- Provider adapter tests MUST prove selected credential ids are traced but secret values are absent.
- Storage tests MUST prove `runtime_credentials` and secret-binding rows never contain resolved provider env values.
- Host retry tests MUST prove fallback retries before tools and refuses replay after `tool.started`.
- Host retry tests MUST prove retry uses a materialized attempt input and does not consume another live prompt generator item.
- Session continuity tests MUST prove Ravi refuses to resume/fork provider sessions when the selected credential compatibility key differs.
- Codex tests MUST prove app-server respawns when the selected credential profile/env changes.
- Claude remote-spawn tests MUST prove only selected `remoteForwardEnvKeys` are forwarded and unsupported auth methods are rejected for remote agents.
- Pi tests MUST prove upstream provider/model metadata is preserved in failure classification.
- Dynamic sanitizer tests MUST prove provider secret env names not present in the built-in sanitizer list are removed from shell/tool env and redacted from events/traces.
- CLI tests MUST prove JSON redaction and admin-only mutation behavior.

## Known Failure Modes

- Treating every 429 as key exhaustion when it is provider shared capacity.
- Retrying after a tool side effect and duplicating writes or external sends.
- Passing provider API keys into shell/tool env.
- Marking a credential invalid because a model is unavailable in one project or region.
- Rotating Codex account profiles without restarting the app-server.
- Resuming or forking a provider session created by a different credential/account.
- Losing the original user prompt or writing duplicate chat messages during fallback retry.
- Retrying by reading the next prompt from the live async generator instead of replaying the failed attempt input.
- Hiding credential exhaustion behind generic `turn.failed`, making operators unable to fix pools.
- String-matching localized or provider-changed error messages without confidence metadata.
