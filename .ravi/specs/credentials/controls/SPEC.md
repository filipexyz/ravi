---
id: credentials/controls
title: "Credential Controls"
kind: capability
domain: credentials
capabilities:
  - controls
tags:
  - secrets
  - audit
  - evidence
  - compliance-lite
applies_to:
  - src/credentials
  - src/cli/commands/credentials.ts
  - .ravi/specs/credentials
owners:
  - rbbt-credentials
status: active
normative: true
---

# Credential Controls

## Intent

This spec defines lightweight engineering controls for the credentials domain.

It is not a formal compliance program and is not a SOC 2 attestation plan. It
exists so the broker is built with control evidence, secret safety and future
auditability from the start.

## Non-Goals

- This spec MUST NOT block the MVP on SOC 2 certification work.
- This spec MUST NOT require formal auditor evidence collection before the
  broker exists.
- This spec MUST NOT turn provider integrations into compliance paperwork.

## Control Map

| Control | Area | Requirement |
| --- | --- | --- |
| `CRED-ID` | Identity | Every brokered use MUST resolve a Ravi caller context when running inside Ravi. |
| `CRED-AUTH` | Authorization | Brokered use MUST check credential capability and action capability before secret read. |
| `CRED-APPROVAL` | Approval | Sensitive actions MUST request approval before secret read. |
| `CRED-STORE` | Secret storage | Secret values MUST live only in approved backends. |
| `CRED-USE` | Use boundary | Secrets MUST be passed only to provider adapters inside broker execution. |
| `CRED-OUTPUT` | Redaction | Public output MUST NOT contain secret values or unredacted sensitive backend coordinates. |
| `CRED-LIFE` | Lifecycle | Connections SHOULD track owner, purpose, status, last use, rotation, expiration and disablement. |
| `CRED-AUDIT` | Audit | Broker intent, decision and result MUST be auditable without secret material. |
| `CRED-BACKEND` | Backend resilience | Backend failures MUST fail closed and return redacted errors. |
| `CRED-CHANGE` | Change gates | Credentials changes MUST include focused tests for secret safety and authorization order. |
| `CRED-INCIDENT` | Leak response | Any exposed provider secret MUST be treated as compromised and rotated. |

## Evidence Artifacts

The implementation SHOULD produce these future evidence sources as a byproduct
of normal operation:

- Connection metadata without secret values.
- Redacted audit events.
- Capability and approval decisions.
- Rotation and disable timestamps.
- Backend kind and redacted secret ref alias.
- Test results for authorization-before-read and redaction.

## Invariants

- Controls MUST be implemented as runtime behavior or tests, not only as
  documentation.
- Controls MUST NOT require storing provider secret values in the Ravi DB.
- Control evidence MUST NOT contain provider secrets, Vault tokens,
  authorization headers or raw backend response bodies.
- Formal compliance work MAY be added later, but MVP work SHOULD remain focused
  on control-ready engineering.

## Validation

- `ravi specs get credentials/controls --mode full --json`
- `bun test pocs/credential-broker/broker.test.ts`
- When implemented: `bun test src/credentials/**/*.test.ts src/cli/commands/credentials.test.ts`

## Known Failure Modes

- The broker works functionally but cannot prove who used which connection.
- Audit rows exist but include secret material.
- Authorization happens after backend secret read.
- Rotation is implemented without timestamps or evidence.
- A future SOC 2 effort requires rewiring core flows because controls were not
  designed into the broker.
