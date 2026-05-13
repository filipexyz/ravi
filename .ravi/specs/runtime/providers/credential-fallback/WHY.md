---
id: runtime/providers/credential-fallback
title: "Why Runtime Provider Credential Fallback"
kind: why
domain: runtime
owners:
  - ravi-dev
status: draft
normative: false
---

# Why

Long-lived Ravi agents increasingly run across several runtime engines: Claude Code, Codex, and Pi with multiple upstream providers. Each engine can fail for different account, quota, rate, billing, or provider-capacity reasons. Without a canonical fallback layer, every adapter either returns a generic `turn.failed` or invents local retry behavior that the host cannot observe, test, or govern.

The fallback layer belongs above provider internals but below agents/tasks/channels:

- Agents should keep saying "use claude", "use codex", or "use pi/openai/gpt-5.5".
- The runtime should choose the concrete credential slot for that attempt.
- Provider adapters should expose enough normalized failure data for the runtime to make a safe fallback decision.

## External Behavior Checked

OpenAI documents API 429 rate limit and quota errors separately, and exposes rate limit headers such as `x-ratelimit-remaining-requests` and `x-ratelimit-reset-tokens`: https://developers.openai.com/api/docs/guides/rate-limits

OpenAI also documents SDK/API error categories including `RateLimitError`, authentication, permission, internal server, and overloaded failures: https://developers.openai.com/api/docs/guides/error-codes#api-errors

Anthropic documents 429 `rate_limit_error`, 402 `billing_error`, 401 `authentication_error`, 403 `permission_error`, and 529 `overloaded_error`: https://platform.claude.com/docs/en/api/errors

Anthropic documents `retry-after` and `anthropic-ratelimit-*` headers for requests and tokens: https://platform.claude.com/docs/en/api/rate-limits

Claude Code documents multiple auth methods, credential storage, auth precedence, `apiKeyHelper`, `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, and `CLAUDE_CODE_OAUTH_TOKEN`. Ravi's default Claude Code usage is subscription/OAuth-oriented, so OAuth token slots should be the primary path and API-key slots should be explicit/operator-scoped: https://code.claude.com/docs/en/iam

Codex documents that cached login details can live in `~/.codex/auth.json` or OS credential storage, and that custom model providers can use OpenAI auth, `env_key`, or no auth: https://developers.openai.com/codex/auth

Google Vertex AI documents 429 `RESOURCE_EXHAUSTED` for capacity/quota conditions and notes that pay-as-you-go 429s can mean shared capacity rather than a specific account's permanent quota exhaustion: https://docs.cloud.google.com/vertex-ai/generative-ai/docs/provisioned-throughput/error-code-429

OpenRouter documents 401 invalid credentials, 402 insufficient credits, 429 rate limiting, and `Retry-After` on 429/503: https://openrouter.ai/docs/api/reference/errors-and-debugging

Groq documents 429 rate limit responses plus `retry-after` and `x-ratelimit-*` headers: https://console.groq.com/docs/rate-limits

## Why Not Just Retry

Blind retries make limit problems worse. A failed attempt might be:

- a transient provider overload where the same credential should be retried later;
- a key/account-specific rate limit where another credential may work;
- a billing or auth failure where the same credential should be quarantined;
- a request/context problem where no credential will help;
- a post-tool failure where replaying the prompt may duplicate side effects.

The system needs classification, health state, and replay safety before it can be automatic.

## Why Session Continuity Must Be Credential-Aware

Provider session ids and thread ids are not neutral routing metadata. Claude Code, Codex, and upstream model providers may bind continuation state to the authenticated account/profile that created it. If Ravi switches credentials and resumes the previous provider session, the retry can fail, reuse inaccessible state, or accidentally mix account-specific context.

The fallback layer therefore needs a redacted session compatibility key. A retry on the same credential can resume when the provider supports it; a retry on another credential starts fresh unless the provider explicitly proves sessions are account-independent.

## Why Retry Needs An Attempt Orchestrator

The current runtime request uses an async prompt generator. A blind retry after `turn.failed` risks consuming the next queued user message instead of replaying the failed one. The fallback implementation needs an attempt orchestrator that materializes the current Ravi turn into an immutable in-memory attempt input, retries that input only, and keeps durable chat/message storage single-write.

## Why Store Metadata Separately From Secrets

Operators need to list, prioritize, disable, and inspect credential pools. That requires metadata in SQLite. Raw secrets do not belong in SQLite, traces, events, logs, or session params. `secretBindings` keep the operational model queryable while leaving values in env, OS keychain, helper commands, provider auth profiles, or a future Ravi secret store.

The binding model must separate the source from the provider target. `CLAUDE_CODE_OAUTH_TOKEN_1` may be the operator's storage env, while `CLAUDE_CODE_OAUTH_TOKEN` is the env key Claude Code actually understands. Keeping that mapping explicit prevents a credential from being stored safely but injected under the wrong name.

Composite credentials are normal for cloud-backed providers. Bedrock, Vertex, Azure/OpenAI, and some custom Codex providers may need multiple values for one credential identity. A list of bindings lets Ravi rotate, test, and redact one credential slot as a unit without persisting a raw env blob.

## Why Dynamic Secret Sanitization Is Required

Ravi already has static sanitizer lists for common env names, but credential pools will introduce arbitrary names such as `CLAUDE_CODE_OAUTH_TOKEN_1`, `ANTHROPIC_API_KEY_1`, `OPENAI_API_KEY_WORK`, or custom Codex `env_key` values. Static lists cannot protect these. The selected credential binding must carry its own sensitive env key list so logs, events, traces, shell hooks, remote spawn, and provider summaries all share the same redaction boundary.

## Why Claude OAuth Is The Default

Ravi's Claude Code usage is usually Claude subscription/OAuth usage, not direct Anthropic API key usage. The credential pool should model that reality directly: Claude Code OAuth slots are the default pool shape, while `ANTHROPIC_API_KEY` slots are useful for direct API, enterprise/cloud, tests, or explicit fallback policies.

This matters because the runtime env starts from process env. If a process-level `ANTHROPIC_API_KEY` is present while an OAuth slot is selected, Claude Code auth precedence can make the effective credential different from the selected credential. Managed Claude credential binding must therefore be auth-method exclusive and strip conflicting Claude auth env vars before provider start.

## Why Codex Is Different

Claude and Pi can be treated mostly as env/profile injection problems. Codex has an app-server process and cached auth profile behavior. A credential switch may require respawning the app-server, and secrets must not leak into the shell tool environment. Codex fallback should start with account profiles and explicit env-key provider support, not broad shell env inheritance.

## Why Claude Remote Execution Is Different

Claude remote spawn currently forwards only a tiny set of auth env vars to SSH/NATS workers. A credential pool can select auth tokens, API keys, cloud credentials, or helper profiles. Remote execution has to be credential-aware: it should forward only the selected credential's allowed env keys and reject credentials that cannot be represented safely on the remote worker.

## Why Pi Needs Extra Care

Pi currently gets a full process env and also owns provider-native tools. Injecting API keys into the Pi process may expose those keys to tool commands or artifacts unless Pi provides a separate provider-secret path. The spec deliberately blocks automatic Pi secret injection for unrestricted tool sessions until that boundary is verified.
