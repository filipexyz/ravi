---
id: runtime/providers/credential-fallback
title: "Runtime Provider Credential Fallback Runbook"
kind: runbook
domain: runtime
owners:
  - ravi-dev
status: draft
normative: false
---

# Runbook

## Configure A Credential Pool

1. Add credentials under `ravi runtime credentials`, not `ravi context credentials`.
2. Prefer `--secret-env <source> --target-env <provider-env>` pairs or provider auth profile refs for the first implementation.
3. Use explicit labels that identify the account/profile without revealing secrets.
4. Restrict credentials by runtime provider, upstream provider, and model when possible.
5. Run `ravi runtime credentials test --provider <id>` before using the pool in an agent.

Example target UX:

```bash
ravi runtime credentials add --provider claude --upstream anthropic --label claude-oauth-1 --auth-method claude-oauth --secret-env CLAUDE_CODE_OAUTH_TOKEN_1 --target-env CLAUDE_CODE_OAUTH_TOKEN
ravi runtime credentials add --provider pi --upstream openai --label openai-2 --secret-env OPENAI_API_KEY_2 --target-env OPENAI_API_KEY --models openai/gpt-5.5
ravi runtime credentials add --provider claude --upstream bedrock --label bedrock-prod --secret-env AWS_ACCESS_KEY_ID_RAVI --target-env AWS_ACCESS_KEY_ID --secret-env AWS_SECRET_ACCESS_KEY_RAVI --target-env AWS_SECRET_ACCESS_KEY --secret-env AWS_SESSION_TOKEN_RAVI --target-env AWS_SESSION_TOKEN
ravi runtime credentials add --provider codex --label codex-profile-2 --auth-profile ~/.codex-profiles/profile-2
```

Each `--secret-env` is where the operator stores the value. Each `--target-env` is what the provider attempt receives. They may differ and the persisted credential must keep this mapping explicit.

## Investigate A Limit Event

1. Inspect the session trace for `runtime.credential.failure_classified`.
2. Check classifier `kind`, `confidence`, provider, upstream provider, model, and request id.
3. Check classifier `scope` and `retryableByCredential`; do not assume every 403 or 429 is credential-specific.
4. Check whether a retry was skipped because a tool had already started.
5. Check credential health for cooldown or invalid status.
6. Check whether the stored provider session was ignored because the selected credential compatibility key changed.
7. Use provider request id/header data in the provider console if needed.

## Manual Recovery

- `rate_limited`: wait for cooldown or reset health after confirming the provider window reset.
- `quota_exhausted`: add credits, increase quota, or disable the exhausted credential.
- `billing_blocked`: fix billing, then run preflight before re-enabling.
- `auth_invalid`: rotate or remove the credential.
- `permission_denied`: verify model/project/org permissions and model allowlist.
- `provider_overloaded`: do not disable credentials unless the provider data proves key-specific exhaustion.

## Safety Checks Before Enabling Auto-Retry

- The classifier must identify the failure with at least medium confidence.
- The classifier must be retryable by credential, not just a generic provider/request failure.
- The current Ravi turn must not have emitted `tool.started`.
- The retry must reuse the original pending prompt without writing a duplicate durable user message.
- The retry must use a materialized attempt input, not read another live prompt generator item.
- The selected next credential must be different and not in cooldown.
- Resume/fork must be disabled unless the selected credential matches the stored session compatibility key.
- The attempt count must be below the configured maximum.
- Dynamic sensitive env keys from the selected credential must be registered with hooks, traces, event redaction, and provider raw summaries before the provider starts.
- Composite credentials must resolve every required binding atomically; if one binding cannot resolve, the attempt must fail before provider start and must not partially inject env.

## Provider-Specific Notes

### Claude

Default Claude Code credentials should be OAuth/subscription slots using `CLAUDE_CODE_OAUTH_TOKEN`. Check whether the selected auth method was OAuth token, API key, auth token, cloud provider credentials, or `apiKeyHelper`.

When an OAuth slot is selected, verify the effective provider env does not still carry `ANTHROPIC_API_KEY` or `ANTHROPIC_AUTH_TOKEN` from process env. Claude Code auth precedence can make an env API key override subscription OAuth, which would make the runtime use a different credential than the resolver selected.

For remote agents, verify the selected credential's `remoteForwardEnvKeys`. SSH/NATS workers must receive only explicitly allowed auth env keys. If the selected auth method needs `ANTHROPIC_AUTH_TOKEN`, cloud credentials, or `apiKeyHelper`, confirm the remote worker supports that path before enabling the credential.

### Codex

Check whether the selected credential changes `CODEX_HOME`, an API key env var, or a custom provider `env_key`. If it changes the app-server process environment, the app-server must respawn before retry. If it changes the account/profile, existing Codex thread/session ids must not be resumed.

### Pi

Check whether the Pi RPC error includes upstream provider, model, HTTP status, code/type, and retry headers. If only free-form `errorMessage` exists, treat the classification as low confidence and avoid aggressive automatic fallback.

## Incident Questions

- Was this failure key/account-specific or provider-wide?
- Was the next credential selected from the same upstream provider or a different one?
- Did the selected credential match the provider session compatibility key?
- Did a tool run before the failure?
- Did the user receive one clear failure message or multiple duplicate messages?
- Did any trace/log/event contain a raw secret value?
- Did any non-standard secret env key leak because it was not present in the static sanitizer list?
