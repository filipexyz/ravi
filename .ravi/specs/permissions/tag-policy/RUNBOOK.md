---
id: permissions/tag-policy/runbook
title: "Tag-Driven Permission Policy Runbook"
kind: runbook
domain: permissions
capability: tag-policy
---

# Tag-Driven Permission Policy Runbook

This runbook describes the target `permissions policies` surface. Until the
policy CLI and materialization ledger exist, treat CLI commands in this file as
implementation targets and use the SQL audits for manual review.

## Inspect Current Policy Tags

```bash
ravi tags search --tag policy.profile.trusted-dev --json
ravi tags search --tag policy.allow.tool.bash --json
```

For broad audits, use SQL joins so the tag slug is visible:

```sql
select b.asset_type, b.asset_id, d.slug, b.source, b.created_at
from tag_bindings b
join tag_definitions d on d.id = b.tag_id
where d.slug like 'policy.%'
order by d.slug, b.asset_type, b.asset_id;
```

## Preview Policy Materialization

Use dry-run before writes:

```bash
ravi permissions policies dry-run --json
ravi permissions policies dry-run trusted-dev-contact-profile --json
```

Expected dry-run output:

- creates;
- refreshes;
- skips because relation exists from another source;
- conflicts recorded in the materialization ledger;
- revokes stale policy-owned grants;
- role closure rejects for forbidden/sensitive outputs;
- rejects forbidden outputs such as `delegate_admin` or `admin system:*`.

## Apply A Policy

```bash
ravi permissions policies apply trusted-dev-contact-profile --json
```

After applying, inspect generated relations:

```sql
select id, subject_type, subject_id, relation, object_type, object_id,
       source, grant_mode, expires_at, revoked_at, reason, issued_by
from relations
where source = 'policy:trusted-dev-contact-profile'
order by subject_type, subject_id, relation, object_type, object_id;
```

Also inspect materialization intent and conflicts:

```sql
select policy_id, policy_version, selector_asset_type, selector_asset_id,
       tag_slug, subject_type, subject_id, relation, object_type, object_id,
       status, relation_id, conflict_source, expires_at, revoked_at
from permission_policy_materializations
where policy_id = 'trusted-dev-contact-profile'
order by selector_asset_type, selector_asset_id, relation;
```

## Explain A Denial Or Allow

Use an explain command that includes actor, surface, executor, and requested
capability:

```bash
ravi permissions explain \
  --actor contact:<contact-id> \
  --chat <chat-id> \
  --agent <agent-id> \
  --cap use:tool:Bash \
  --json
```

The explanation should show:

- direct actor grants;
- profile memberships;
- policy tags that created memberships or grants;
- surface constraints and overrides;
- executor agent ceiling;
- turn approval ceiling;
- final allow/deny.

## Reconcile After Tag Removal

After removing a policy tag:

```bash
ravi tags detach policy.profile.trusted-dev --contact <contact-id> --json
ravi permissions policies reconcile trusted-dev-contact-profile --json
```

The tag detach path should trigger this automatically. Manual reconcile is a
debug/backfill command, not the normal revocation mechanism.

The reconciler must revoke or suspend only grants owned by
`policy:trusted-dev-contact-profile`. It must not revoke manual/config grants
with the same tuple.

If a manual/config grant still authorizes the same tuple, `explain` and the
ledger must show that policy no longer owns the authority even though the
tuple remains allowed through another source.

## Revalidate Role Closure

When a role used by policy-managed membership changes:

```bash
ravi permissions policies reconcile --role trusted-dev --json
```

Expected:

- recompute the role closure;
- reject/suspend memberships if the role now contains forbidden outputs;
- invalidate affected runtime contexts before the next authority check;
- report manual/config memberships separately from policy-owned memberships.

## Audit Dangerous State

Broad contact tag grants:

```sql
select subject_type, subject_id, relation, object_type, object_id, source
from relations
where relation = 'read_tagged_contacts'
  and object_type = 'system'
  and object_id = '*'
  and revoked_at is null
order by subject_type, subject_id;
```

Forbidden policy outputs:

```sql
select *
from relations
where source like 'policy:%'
  and (
    (relation = 'admin' and object_type = 'system' and object_id = '*')
    or relation = 'delegate_admin'
  );
```

Policy-generated permanent grants:

```sql
select *
from relations
where source like 'policy:%'
  and grant_mode = 'permanent';
```

Permanent policy grants are allowed only when the rule explicitly declares
permanence and the review trail shows why.
