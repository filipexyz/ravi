---
id: permissions/explain/checks
title: "Permission Explainability Checks"
kind: checks
domain: permissions
capability: explain
---

# Permission Explainability Checks

## Regression Tests

- A delegated denial for `execute group:g1` records the provider-runtime
  decision, subject, object, context id, and reason in `permission_denials`.
- Trigger the same denial in a context with zero actor/surface capabilities and
  a context with populated actor/surface capabilities; assert `detail_json`
  distinguishes the two cases.
- `ravi permissions check --permission use --object-type tool --object-id Bash
  --json` returns the same final decision as the provider-runtime facade for
  identical inputs.
- `ravi permissions materialize --subject-type agent --subject-id a1 --json`
  attributes each capability to a materializer source such as
  `runtime-bootstrap`, `agent-runtime-permissions`, or
  `contact-policy-permissions`.
- Actor/surface capability counts surfaced anywhere in explain or denial output
  carry the snapshot timestamp of the context that produced them.
- Diagnostics invoked from an agent runtime context apply resource-visibility
  filtering; a hidden session/chat behaves as not-found.

## Audit Queries

Recent provider-runtime denials:

```sql
select subject_type, subject_id, relation, object_type, object_id,
       context_id, reason, detail_json, created_at, resolved_at
from permission_denials
order by created_at desc
limit 50;
```
