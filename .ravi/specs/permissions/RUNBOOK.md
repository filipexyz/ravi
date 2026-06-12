---
id: permissions/runbook
title: "Permissions Runbook"
kind: domain
domain: permissions
status: active
normative: false
---

# Permissions Runbook

## Diagnose A Denial Wave

Symptom: many denials with `surfaceCapabilityCount=0` (or actor/agent count
zero) across different chats/agents at once.

1. Do not start by granting. A wave almost always means a lifecycle event,
   not missing configuration.
2. Check whether the blocked subjects ever had grants:

   ```sql
   select revoked_at is not null as revoked, count(*)
   from relations
   where subject_type = ? and subject_id = ?
   group by 1;
   ```

3. Look for revocation batches (many tuples sharing one `revoked_at`):

   ```sql
   select revoked_at, count(*) as tuples,
          count(distinct subject_type || ':' || subject_id) as subjects
   from relations
   where revoked_at is not null
   group by revoked_at
   having count(*) >= 10
   order by revoked_at desc
   limit 10;
   ```

4. Identify what survived — a cleanup that preserved only the issuer's own
   principals is a self-preservation incident:

   ```sql
   select subject_type, subject_id, count(*), max(issued_by)
   from relations
   where revoked_at is null
   group by 1, 2
   order by 3 desc;
   ```

5. Attribute the batch: `issued_by` on surviving grants created minutes
   before the batch, and the `contexts` table for the issuing session:

   ```sql
   select context_id, agent_id, session_key, kind, created_at
   from contexts
   where context_id = ?;
   ```

6. Decide between restore (batch was unintended or premature) and migrate
   forward (replacement roles/policies exist). Restoring is correct when no
   replacement was materialized.

## Break-Glass Recovery (admin-independent)

An incident that revokes every agent's `admin system:*` does NOT lock out
recovery. Superadmin-scoped permission commands (`grant`, `init`,
`restore-batch`) are gated by `enforceScopeCheck`, which allows them when there
is no agent principal in context — i.e. a direct operator CLI invocation.

The recovery path is therefore: run the `ravi` CLI directly as the operator (no
agent runtime context), not through a bot/agent session. A bot session that
lost admin will be denied; the operator shell will not. This is the intended
break-glass channel and requires no agent to hold admin.

## Restore A Bulk Revocation Batch

Preferred path:

```bash
ravi permissions restore-batch <revocation_batch_id> --json
ravi permissions restore-batch <revocation_batch_id> --apply --confirm restore-revocation
```

Subject-scoped restore (recover one subject without touching the rest of the
batch — no SQL):

```bash
ravi permissions restore-batch <revocation_batch_id> --subject agent:dev --json
ravi permissions restore-batch <revocation_batch_id> --subject agent:dev --apply --confirm restore-revocation
```

Timestamp-only restore is legacy fallback and may restore unrelated revocations
from the same second. Use only when the batch predates `revocation_batch_id` and
after inspecting the exact matched tuples. `--subject` also applies here:

```bash
ravi permissions restore-batch <revoked_at> --revoked-at --json
ravi permissions restore-batch <revoked_at> --revoked-at --subject agent:dev --apply --confirm restore-revocation
```

Then:

1. Re-run the legacy preview (`ravi permissions legacy --json`) to confirm
   the restored debt is visible again and intentionally scheduled.
2. Rotate or wait out active turn contexts so restored authority is picked up
   (delegated contexts snapshot at turn start).
3. Trigger a test turn on a previously denied surface and confirm allow.

Selective alternative: re-granting the same tuple via
`ravi permissions grant` reactivates it (the upsert clears `revoked_at`), so
narrow recoveries can go tuple-by-tuple through the CLI without SQL.

## Retire Legacy Grants Safely

1. Materialize replacement authority first: roles + memberships
   (`role:<id>` grants, `<principal> member role:<id>`,
   `<surface> constrain role:<id>`), or policy materializations.
2. Preview: `ravi permissions legacy --json`. Read the summary, not just the
   count.
3. Simulate blast radius: which subjects drop to zero active capabilities if
   the candidates are revoked. Zeroed chat surfaces mean every delegated turn
   from those chats will deny.
4. Apply in bounded phases with `--limit` and, where possible, `--subject`,
   starting with subjects already covered by replacement authority.
5. After each phase: run a real turn from an affected surface, check
   `ravi.audit.denied`, and re-run the preview.
6. Never run an unbounded apply from an agent session. Above-threshold
   applies are operator decisions (see Bulk Revocation Safety in the domain
   SPEC).

## Grant The Right Thing After A Denial

1. Run `ravi permissions explain --denial <id> --json` (or the documented
   explain invocation) to get grant state per branch.
2. `revoked`/`expired`: restore or re-issue the original authority; do not
   invent a new grant shape.
3. `never_granted`: prefer adding the principal to an existing role; create a
   role if a pattern is emerging; use a direct scoped grant only for genuine
   one-offs.
4. `constrained`: the surface is doing its job. Change the constraint role or
   add a surface-level `delegate_<relation>` override only with operator
   intent.
5. `ceiling`: the executor agent lacks the capability; widening the agent
   widens every actor that can reach it — confirm that is intended.
6. Avoid full-access templates on chat/contact subjects. That is the legacy
   shape being retired.
