# Credentials / WHY

## Problem

Ravi has multiple secret consumers — runtime provider adapters (Claude, Codex, Pi API keys) and channel adapters (Slack tokens, future channel secrets). Without a unified credentials domain, each consumer invents its own storage, authorization, redaction, and rotation patterns.

## Decision

Create a `credentials` domain that owns the full secret lifecycle through a single broker abstraction. Both runtime provider credentials and channel credentials resolve secrets through the same authorization and backend infrastructure. The broker enforces authorization before any secret read, abstracts backend implementation (Keychain, Vault, KMS), resolves composite secrets atomically, and centralizes redaction and audit.

## Tradeoff

A unified domain adds a new abstraction layer. This is intentional: the broker is the authorization checkpoint that prevents direct backend access and ensures consistent security controls across all secret consumers.
