# Credentials Controls / CHECKS

## Composite Secret Controls

- Composite connections (e.g., Slack app token + bot token) MUST resolve all parts atomically.
- If one part fails, no parts are returned.
- Each part has its own `SecretRef` and redacted alias.
- Parts required together (e.g., Socket Mode connect) cannot be resolved independently.

## Temporary Env Fallback Controls

- When a broker-managed connection exists and is active, the runner MUST prefer broker-resolved secrets.
- When falling back to env vars, the runner MUST emit a deprecation warning.
- Env fallback MUST be disableable by operator policy.
- Env var values MUST be redacted by the standard env sanitizer in logs, traces, and events.
- Env fallback MUST NOT be used when the broker is available and a registered active connection exists.

## Slack Header / Token Redaction

- Raw Slack token prefixes (`xapp-`, `xoxb-`, `xoxp-`, `xoxa-`) MUST be caught by redaction filters.
- `Authorization: Bearer <token>` headers in Slack HTTP requests MUST be redacted before logging.
- Slack API request bodies containing `token` fields MUST be redacted before logging.
- Slack WebSocket connection URLs (which may contain ephemeral tokens) MUST be redacted before logging.
- Redaction MUST apply to all output surfaces: daemon logs, NATS events, CLI output, error messages, traces, and audit.

## Fail-Closed Behavior

- Disabled connection: broker returns denial, no secret material.
- Expired connection: broker returns denial, no secret material.
- Revoked connection: broker returns denial, no secret material.
- Missing connection: broker returns denial, no hint about secret existence.
- Unauthorized caller: broker returns denial, no hint about secret existence.
- Backend unreachable: broker returns failure, does not fall through to env or alternative.
- Partial composite resolution: broker returns failure, no partial results.
- All fail-closed errors include actionable context with redacted references.

## Audit Completeness

- Successful resolution: audit record with caller, connection, action, timestamp.
- Denied resolution: audit record with caller, connection, action, denial reason, timestamp.
- Failed resolution: audit record with caller, connection, action, failure reason (redacted), timestamp.
- No audit record contains raw secret values.
- Connection lifecycle transitions are audited with actor and reason.
- Operator CLI actions (disable, enable, rotate, remove) are audited.

## Cross-Domain Redaction Consistency

- Runtime provider credential redaction (`runtime/providers/credential-fallback`) and channel credential redaction (`channels/credentials`) MUST use the same redaction infrastructure.
- Dynamic sensitive env key sets from both domains MUST be merged into the env sanitizer.
- A secret that is redacted in one output surface MUST be redacted in all output surfaces.

## Validation Commands

```bash
ravi specs get credentials/controls --mode checks --json
ravi specs get credentials/controls --mode full --json
bun run typecheck
bun run build
```
