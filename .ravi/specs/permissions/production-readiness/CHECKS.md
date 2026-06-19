---
id: permissions/production-readiness/checks
title: "Permissions Production Readiness Checks"
kind: checks
domain: permissions
capability: production-readiness
---

# Permissions Production Readiness Checks

## G2 — Cross-Evaluator Agreement (missing, required)

For a generated matrix of (subject, grants, request) cases covering exact,
wildcard `*`, trailing `prefix*`, tool-group membership, nested roles, and
constraints, assert:

```text
can(subjectType, subjectId, relation, objectType, objectId)
  === canWithCapabilities(snapshotSubjectCapabilities(subjectType, subjectId),
                          relation, objectType, objectId)
```

And for delegated cases, assert the explain final decision equals a real
enforcement check:

```text
explainPermissionDecision(input).final.allowed
  === canWithCapabilities(
        materializeDelegatedAuthority(principals).effectiveCapabilities,
        relation, objectType, objectId)
```

Any mismatch MUST fail.

## G4 — Core Unit Tests (missing, required)

`src/permissions/delegation.test.ts` MUST cover:

- intersection denies when any branch lacks the capability;
- surface with no decision inherits the actor branch;
- surface direct grant allows; surface `deny_<relation>` vetoes over actor +
  agent allow;
- surface `constrain role:<id>` bounds to closure; out-of-closure denies;
- nested role expansion; cyclic role membership terminates;
- agent-level `delegate_` satisfies actor branch only; surface-level `delegate_`
  satisfies both;
- automation and unresolved actors get empty effective capabilities even when
  the executor agent is superadmin;
- `delegate_admin` is dropped.

`src/permissions/capability-context.test.ts` MUST cover:

- `capabilitiesAllow` for exact/wildcard/pattern/tool-group;
- `admin system:*` short-circuit;
- `canWithCapabilityContext` lets live superadmin win for `agent-runtime` but
  NOT for delegated/turn-runtime;
- `agent-runtime` context picks up a live grant added after issuance.

## G5 — Recovery Paths (partially missing, required)

- Subject-scoped restore: revoke a subject's grants in a batch, then restore
  only that subject without raw SQL; assert other subjects in the batch stay
  revoked.
- Admin-independent break-glass: an operator path (no agent `admin system:*`)
  can grant/restore; assert it works when every agent's admin is revoked.

## G6 — Configuration Reconcile (required)

- Boot reconcile assigns each in-use automation principal (cron/trigger/
  session-followup/daemon-restart) to a role whose closure covers its needs;
  assert a previously denied automation passes after reconcile.
- Reconcile dry-run on a steady-state DB reports zero unintended drift.
- Assert no bootstrap/issuer subject retains `admin system:*` or full-access
  wildcard sets unless explicitly allow-listed.

## G8 — Health (required)

Wire into `ravi doctor`:

```sql
-- active contexts still carrying admin system:*
select count(*) from contexts
where revoked_at is null and (expires_at is null or expires_at > unixepoch())
  and capabilities_json like '%"permission":"admin"%'
  and capabilities_json like '%"objectId":"*"%';
```

## Smoke (manual, today)

```bash
# happy path via role
ravi permissions check "agent:audit" execute "group:sessions_info"   # ALLOWED
# fail-closed out of role
ravi permissions check "agent:audit" execute "group:whatsapp_group_create"  # DENIED
# delegated explain on a zeroed surface with an authorized actor inherits
ravi permissions explain execute group:sessions_info \
  --agent audit --actor agent:audit --chat chat:<any> --json
```
