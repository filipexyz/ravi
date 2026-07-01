# Credentials Broker / WHY

## Problem

Without a central broker, every secret consumer (channel adapter, runtime provider adapter, CLI) must know how to read the specific backend (Keychain, Vault, KMS), check authorization independently, handle composite secrets, and implement redaction. This leads to inconsistent security controls, duplicated backend logic, and authorization gaps.

## Decision

The credentials broker is the single authorization and resolution gateway. Every caller requests secrets through the broker, which checks authorization, validates connection state, resolves secret refs through the configured backend, and returns the value for immediate use. Callers never learn backend coordinates or storage layout.

## Tradeoff

The broker adds a resolution hop before every secret use. This is intentional: the hop is the authorization checkpoint. The tradeoff is latency for security — every secret access is authorized, audited, and consistently redacted.
