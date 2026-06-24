# Credential Controls Runbook

## Applying Controls To A Change

For any credentials change:

1. Identify affected controls from `credentials/controls`.
2. Confirm the change does not expose secret values.
3. Confirm authorization happens before backend secret read.
4. Confirm audit/evidence records intent and outcome.
5. Add or update focused tests.

## Minimum Review Packet

A meaningful credentials implementation review should answer:

- Which provider/connection/action path changed?
- Which backend reads/writes/deletes are possible?
- What happens before the first secret read?
- What output can an agent or CLI see?
- What audit row is written?
- What lifecycle fields change?
- What test proves the secret did not leak?

## Adding Lifecycle Fields

When adding production metadata, include fields for:

- owner
- purpose
- scopes
- status
- createdAt
- updatedAt
- lastUsedAt
- rotatedAt
- expiresAt
- disabledAt
- createdBy and updatedBy when caller identity is available

## Adding Evidence

Evidence should be automatic and redacted.

Good evidence:

- authorization decision id;
- approval status;
- redacted connection id;
- backend kind;
- result status;
- error code without secret-bearing body.

Bad evidence:

- provider token;
- raw request headers;
- Vault token;
- raw backend response body;
- chat text containing pasted secrets.

## Escalating To Formal Compliance

Open a formal compliance/SOC 2 spec only when at least one is true:

- customer or enterprise sales requires it;
- hosted production credentials are operated for third parties;
- auditor evidence collection is needed;
- internal governance asks for formal control ownership.
