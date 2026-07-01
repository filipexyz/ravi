---
id: credentials
title: Credentials
kind: domain
domain: credentials
capabilities:
  - broker
  - controls
tags:
  - credentials
  - security
  - secrets
  - broker
applies_to:
  - src/credentials/
owners:
  - ravi-dev
status: draft
normative: true
---

# Credentials

## Intent

Ravi credentials is the domain that owns provider/action secret lifecycle: registration, storage, resolution, authorization, rotation, revocation, redaction, and audit.

The credentials domain provides a single broker abstraction so that both runtime provider credentials (Claude, Codex, Pi API keys) and channel credentials (Slack tokens, future channel secrets) resolve secrets through the same authorization and backend infrastructure without exposing raw secrets to callers, logs, events, or public output.

## Invariants

- All provider/action secrets MUST be stored in a backend (Keychain, Vault, KMS) behind the credentials broker. Ravi metadata stores only secret refs and redacted aliases.
- Callers MUST NOT read secret backends directly. All secret resolution MUST go through the broker, which enforces authorization before any backend read.
- The broker MUST fail closed when the connection is disabled, expired, missing, mismatched, or unauthorized.
- Composite secrets (multiple secret parts under one connection) MUST be resolved atomically.
- Raw secret values MUST NOT appear in SQLite, markdown, runtime context keys, runtime/model credential pools, channel config, prompts, logs, traces, events, CLI/JSON output, error messages, or audit records.
- Redacted aliases and secret refs MUST be used wherever a human-readable reference is needed.
- The `ravi credentials` CLI is the generic entry point for credential CRUD. Domain-specific facades (e.g., `ravi runtime credentials`, future `ravi channels credentials`) MUST delegate to the generic domain.

## Boundary

- **`credentials/broker`**: The broker service that stores metadata, resolves secret refs through backends, and checks authorization.
- **`credentials/controls`**: Security controls for secret redaction, fail-closed behavior, env fallback policy, and audit.
- **`runtime/providers/credential-fallback`**: Runtime provider credential pool, fallback chains, rate-limit classification, and provider session continuity. Uses the broker for secret resolution but owns pool selection and provider-specific retry logic.
- **`channels/credentials`**: Channel credential connections (Slack, future channels). Uses the broker for secret resolution but owns channel-specific metadata, lifecycle, and action capabilities.

## Validation

- `ravi specs get credentials --mode full --json`
- `ravi specs get credentials/broker --mode full --json`
- `ravi specs get credentials/controls --mode checks --json`
