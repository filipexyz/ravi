---
id: permissions/enterprise/audit/checks
title: "Complete Tamper-Evident Audit Checks"
kind: checks
domain: permissions
capability: enterprise
feature: audit
---

# Complete Tamper-Evident Audit Checks

## Unit / Integration Tests

- An authorized sensitive action (authority mutation allowed, Bash execution
  allowed, contact write allowed) emits an ALLOW audit record with full
  provenance (decision, mode, actor/operator, agent, surface, object, action,
  timestamp).
- A denied action still emits to `ravi.audit.denied` (compatibility preserved)
  AND carries the same provenance schema as allows.
- Allow and deny records are built by the shared `audit-provenance` builder and
  are structurally comparable.
- A record contains no secrets, no `contextKey`, no raw credentials, and no full
  message body (redaction parity with the existing deny rules).
- Hash chain: tampering with or deleting any record is detected by the
  verification command; an intact log verifies clean.
- A privileged action whose audit cannot be persisted or queued is REFUSED.
- Records under legal-hold are NOT removed by context pruning or audit
  compaction.

## Export

- With a configured sink, emitted records are delivered and acknowledged;
  unacknowledged records are retried and survive process restart.
- After acknowledged export, loss of the local operational DB does not lose
  acknowledged records.

## Doctor

- A check reports whether tamper-evidence (hash chain or external sink) is
  enabled; absent in an enterprise context, it is a warning.
- A check reports audit-export backlog / last-acknowledged position.

## Audit Queries

```sql
-- decisions by mode and outcome over a window
select mode, decision, count(*)
from audit_records
where created_at >= ?
group by mode, decision
order by count(*) desc;

-- chain integrity: gaps in the sequence
select prev.seq as broken_after
from audit_records prev
left join audit_records next on next.prev_hash = prev.hash
where next.seq is null
order by prev.seq desc;
```

## Manual Compliance Review

- Demonstrate that any sensitive action (allow or deny) is reconstructable from
  the audit log alone: who, what, when, under which authority mode, and why.
- Demonstrate that a deleted or altered record is detectable.
- Demonstrate export to the customer SIEM and retention/legal-hold behavior.
