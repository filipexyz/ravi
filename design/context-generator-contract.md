# External CLI Context Generator Contract

This document defines the contract for any generator/launcher that executes an external CLI under a Ravi-issued runtime context.

## Goal

Allow an external CLI to:

1. receive a least-privilege child context from a parent Ravi session,
2. resolve its own identity and lineage,
3. check or request additional capabilities through the normal approval flow,
4. execute a real Ravi action without relying on agent/session env spoofing.

The current reference implementation lives in `src/reference/context-cli.ts`.

## Core Rule

`RAVI_CONTEXT_KEY` is the only required runtime credential for an external CLI.

A generator must not depend on:

- `RAVI_AGENT_ID`
- `RAVI_SESSION_KEY`
- `RAVI_SESSION_NAME`

Those values are session/runtime details owned by Ravi itself. The external CLI should discover identity by introspecting the context, not by reconstructing it from environment variables.

## Issuance Contract

Parent sessions issue child contexts through:

```bash
ravi context issue <cliName> [--allow permission:objectType:objectId[,..]] [--ttl 30m|2h|1d] [--inherit]
```

Expected JSON output shape:

```json
{
  "contextId": "ctx_...",
  "contextKey": "rctx_...",
  "kind": "cli-runtime",
  "cliName": "example-cli",
  "agentId": "dev",
  "sessionKey": "agent:dev:whatsapp:main:group:123",
  "sessionName": "dev-group-123",
  "parentContextId": "ctx_parent_...",
  "createdAt": 1710000000000,
  "expiresAt": 1710003600000,
  "capabilities": [
    { "permission": "execute", "objectType": "group", "objectId": "daemon" }
  ],
  "capabilitiesCount": 1,
  "source": { "...": "..." },
  "metadata": {
    "parentContextId": "ctx_parent_...",
    "parentContextKind": "runtime",
    "issuedFor": "example-cli",
    "issuedAt": 1710000000000,
    "issuanceMode": "explicit"
  },
  "env": {
    "RAVI_CONTEXT_KEY": "rctx_..."
  }
}
```

## Generator Responsibilities

The generator/launcher must:

1. call `ravi context issue` with a stable `cliName`,
2. pass `env.RAVI_CONTEXT_KEY` into the child process,
3. keep the parent environment unless there is an explicit reason not to,
4. avoid synthesizing additional Ravi identity env vars,
5. treat the child context as ephemeral and re-issue it for new runs instead of caching blindly.

The generator may pass convenience env like `RAVI_BIN` for testing, but that is not part of the runtime identity contract.

## External CLI Responsibilities

An external CLI running under this contract should:

1. require `RAVI_CONTEXT_KEY`,
2. resolve identity with `ravi context whoami`,
3. inspect granted capabilities with `ravi context capabilities` or `ravi context check`,
4. request missing capabilities with `ravi context authorize`,
5. only execute the target Ravi command after authorization succeeds.

## Identity Contract

Identity is resolved through:

```bash
ravi context whoami
```

Minimum fields the CLI can rely on:

- `contextId`
- `kind`
- `agentId`
- `sessionKey`
- `sessionName`
- `source`
- `createdAt`
- `expiresAt`
- `lastUsedAt`
- `revokedAt`
- `metadata`
- `capabilitiesCount`

This is the canonical way for the external CLI to know who issued it and which session/source it belongs to.

## Capability Contract

Dry-check:

```bash
ravi context check <permission> <objectType> <objectId>
```

Approval/escalation:

```bash
ravi context authorize <permission> <objectType> <objectId>
```

The CLI must interpret `authorize` results as follows:

- `allowed=true, approved=false, inherited=true`
  The capability was already present in the child context.
- `allowed=true, approved=true, inherited=false`
  The capability was newly approved and added to the current context.
- `allowed=false, approved=false, inherited=false`
  The request was denied or timed out. Use `reason` for operator-visible output.

The approval is attached to the current context record; no separate token exchange is required after success.

## Lineage and Audit Contract

Every child context issued for an external CLI must preserve lineage through metadata:

- `parentContextId`
- `parentContextKind`
- `issuedFor`
- `issuedAt`
- `issuanceMode`

If the parent context already carries `approvalSource`, it is propagated into the child metadata.

This means `cliName` is not cosmetic. It is part of the audit trail and should be stable across runs for the same external CLI integration.

## Expiration and Revocation Contract

Context resolution can fail with:

- `Context not found`
- `Context revoked`
- `Context expired`

External CLIs must surface these failures directly and stop. The correct recovery path is to issue a fresh child context, not to keep retrying with the same key.

## Minimal Happy Path

```bash
# parent Ravi session
ravi context issue ext-cli --allow execute:group:daemon

# child external CLI
ravi context whoami
ravi context authorize execute group daemon
ravi daemon status
```

## Reference Scope for v3

This contract intentionally standardizes only:

- issuance,
- identity discovery,
- capability checks,
- approval semantics,
- lineage metadata,
- action gating.

Follow-up work remains separate:

- `context list/info/revoke`
- richer lineage inspection
- generator SDK / helper layer for external CLIs
- teaching layer / skill docs for agent authors
