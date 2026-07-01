---
id: credentials/controls
title: Credentials Controls
kind: capability
domain: credentials
capability: controls
tags:
  - credentials
  - security
  - redaction
  - fail-closed
  - audit
applies_to:
  - src/credentials/
owners:
  - ravi-dev
status: draft
normative: true
---

# Credentials Controls

## Intent

Security controls for the credentials domain. These rules apply to all credential consumers (runtime providers, channel adapters, CLI, SDK, audit, and diagnostics) and govern redaction, fail-closed behavior, env fallback policy, and audit requirements.

## Invariants

### Redaction

- Raw secret values MUST NOT appear in:
  - SQLite tables (including `ravi.db`, `chat.db`, and any future databases)
  - Markdown files (specs, agent instructions, heartbeat, notes)
  - Runtime context keys or runtime/model credential pools
  - Channel config or `ChannelInstance` records
  - Prompts, agent instructions, or system messages
  - Logs (daemon logs, structured logs, debug output)
  - Traces (session events, turn traces, provider raw summaries)
  - NATS events (`ravi events stream`, JetStream messages)
  - CLI/JSON output (all `--json` surfaces)
  - Error messages (broker errors, connection failures, API errors)
  - Audit records
  - Notion pages, spec text, or documentation
- Authorization headers containing secrets (e.g., `Authorization: Bearer xoxb-...`) MUST be redacted in any logged HTTP request/response.
- Slack request bodies containing tokens MUST be redacted before logging.
- Backend secret coordinates (Keychain item names, Vault paths, KMS ARNs) MUST NOT appear in public output.

### Fail-Closed

- The broker MUST refuse secret resolution when:
  - Connection is disabled/suspended/expired/revoked/missing
  - Caller lacks required capability
  - Backend is unreachable (fail closed, do not fall through to env)
  - Secret ref cannot be resolved
- Fail-closed errors MUST NOT reveal whether the secret exists or what backend is configured.
- When fail-closed triggers, the error MUST be actionable: connection status, missing capability, or backend availability, with redacted context.

### Temporary Env Fallback

- Env vars MAY be used as temporary local smoke/dev-mode inputs only.
- When a broker-managed connection exists and is active, the runner MUST prefer broker-resolved secrets over env vars.
- When falling back to env vars, the runner MUST emit a deprecation warning.
- Env fallback MUST be disabled by operator policy in production deployments.
- Env vars used as fallback MUST still be redacted from logs, traces, and events by the standard env sanitizer.

### Composite Secrets

- Composite secrets (multiple secret parts under one connection) MUST be resolved atomically.
- Partial resolution MUST fail the entire request.
- Each part of a composite secret MUST have its own `SecretRef`, redacted alias, and backend coordinate.
- Composite secret parts MUST NOT be resolvable independently when the connection contract requires atomicity (e.g., Slack Socket Mode requires both app token and bot token).

### Audit

- All secret resolution attempts (successful and denied) MUST be auditable.
- Audit records MUST include: caller identity, connection id, action requested, result (resolved/denied/failed), timestamp.
- Audit records MUST NOT include raw secret values.
- Connection lifecycle transitions MUST be audited.
- Operator actions (disable, enable, rotate, remove) MUST be audited with actor and reason.
