---
id: permissions/enterprise/audit
title: "Complete Tamper-Evident Audit"
kind: feature
domain: permissions
capability: enterprise
feature: audit
capabilities:
  - audit
  - compliance
  - observability
tags:
  - permissions
  - enterprise
  - audit
  - compliance
  - siem
applies_to:
  - src/permissions/scope.ts
  - src/permissions/denials.ts
  - src/events/audit-stream.ts
  - src/permissions/audit-provenance.ts
owners:
  - ravi-rebac
  - ravi-dev
status: active
normative: true
---

# Complete Tamper-Evident Audit

## Intent

Today Ravi audits only denials: `ravi.audit.denied` is published on deny
(`scope.ts`) and denials are recorded in `permission_denials`. There is no
allow-side audit and no tamper-evidence. In a regulated industry an action you
cannot prove did not happen legally happened — so the audit log is the defense,
and it MUST cover allows, be tamper-evident, and survive off-box.

This feature makes the audit trail complete, integrity-protected, and
exportable, without weakening the local-first guarantee (the log lives on-box by
default and is pushed to a customer sink, not a vendor cloud).

## Definitions

- `audit record`: an immutable entry describing one authority decision or
  privileged action.
- `tamper-evident`: any modification or deletion of a record is detectable
  (e.g. hash-chained records, or an append-only external sink).
- `sink`: a customer-controlled destination (SIEM, syslog, object storage) the
  audit stream is exported to.

## Invariants

- Every authority decision that affects state, disclosure, delivery, or an
  external effect MUST be auditable, including ALLOWS, not only denies.
- Audit verbosity MAY be configurable, but sensitive actions (tool/Bash/CLI
  mutation, contact/CRM writes, session access, app execution, gateway egress,
  permission mutation, break-glass) MUST always be audited on allow and deny.
- Audit records MUST be tamper-evident: each record MUST be chained or signed so
  that deletion or modification is detectable, and the chain head MUST be
  verifiable.
- Audit records MUST be exportable to a customer-controlled sink and MUST
  survive loss of the local operational DB (export is not best-effort for
  records that have not yet been acknowledged by the sink).
- Audit records MUST carry full authority provenance: decision (allow/deny),
  mode (delegated / break-glass / automation / agent), actor/operator principal,
  executor agent, surface, object, action, timestamp, reason, and the grant
  state for denies (reuse `permissions/explain` diagnosis).
- Audit records MUST NOT contain secrets, context keys, raw credentials, or full
  message content; they reference identities and objects, not payloads (extends
  the existing `ravi.audit.denied` redaction rules to allow records).
- Retention and legal-hold MUST be configurable; records under legal-hold MUST
  NOT be pruned by compaction.
- Audit emission MUST be reliable for actions gated on it: a privileged action
  whose audit cannot be persisted/queued MUST be refused, not silently allowed
  (consistent with break-glass).

## Event Surface

- The deny topic `ravi.audit.denied` MUST be preserved for compatibility.
- An allow/decision topic (e.g. `ravi.audit.decision` or `ravi.audit.allowed`)
  MUST carry the same provenance schema for allows of sensitive actions.
- Both MUST share one provenance builder (`audit-provenance`) so allow and deny
  records are structurally comparable.
- The audit stream MUST be consumable by an exporter that ships to the
  configured sink and tracks acknowledgment.

## Integrity

- Records SHOULD be hash-chained (each record includes the hash of the prior
  record) so the local log is self-verifying, OR streamed to an append-only
  external sink that provides integrity.
- A verification command MUST be able to detect a broken chain / missing
  sequence.

## Acceptance Criteria

- A sensitive allow (e.g. an authorized `permissions grant`, an authorized Bash
  execution) produces an audit record with full provenance, not just denies.
- Deleting or editing a record is detectable by the verification command.
- With a configured sink, records are exported and acknowledged; killing the
  local DB after export does not lose acknowledged records.
- A privileged action MUST refuse if its audit cannot be recorded or queued.
- Audit records contain no secrets, context keys, or message payloads.
- Records under legal-hold are retained across `prune`/compaction.
