---
id: permissions/explain/checks
title: "Permission Explainability Checks"
kind: checks
domain: permissions
capability: explain
---

# Permission Explainability Checks

## Regression Tests

- Grant `chat:c1 execute group:g1`, revoke it, trigger a delegated denial for
  `execute group:g1` on `chat:c1`; assert the diagnosis reports grant state
  `revoked` with the tuple's `revoked_at` and issuer, not `never_granted`.
- Trigger the same denial on a chat that never had the grant; assert grant
  state `never_granted` and that the two diagnoses are distinguishable in
  `detail_json` and in the `ravi.audit.denied` payload.
- Revoke 50+ relations for one subject in a single batch; assert the next
  denial for that subject reports one revocation event with count, timestamp,
  and issuer instead of listing tuples individually.
- `ravi permissions explain use tool:Bash --agent a1 --actor contact:c1 --chat
  chat:s1 --json` returns per-branch verdicts (agent, actor, surface, turn),
  matched tuples with provenance, and a final decision that equals the live
  enforcement result for identical inputs.
- `ravi permissions explain --denial <id> --json` reconstructs the recorded
  decision and includes `currentlyDenied: true|false` after re-evaluating
  present graph state.
- Explain for an allow attributes each effective capability to direct grant,
  role expansion (`role:<id>` path), delegation override, or turn approval.
- Explain recommendations rank role membership before scoped direct grants
  and never include `*` object ids unless `--broad` (or equivalent) is passed.
- Explain without `--actor`/`--chat` states that delegated branches were not
  evaluated.
- Actor/surface capability counts surfaced anywhere in explain or denial
  output carry the snapshot timestamp of the context that produced them.
- Explain invoked from an agent runtime context applies resource-visibility
  filtering; a hidden session/chat behaves as not-found.

## Audit Queries

Near-miss tuples for a subject (would have authorized, now inactive):

```sql
select subject_type, subject_id, relation, object_type, object_id,
       source, issued_by, revoked_at, expires_at
from relations
where subject_type = ? and subject_id = ?
  and (revoked_at is not null
       or (expires_at is not null and expires_at <= unixepoch()))
order by coalesce(revoked_at, expires_at) desc;
```

Revocation batches (candidate events):

```sql
select revoked_at, count(*) as tuples,
       count(distinct subject_id) as subjects
from relations
where revoked_at is not null
group by revoked_at
having count(*) >= 10
order by revoked_at desc;
```
