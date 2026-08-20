---
id: crm
title: "CRM"
kind: domain
domain: crm
capabilities:
  - contacts
  - accounts
  - opportunities
  - tasks
  - facts
  - pipelines
  - relationships
tags:
  - crm
  - customer-data
  - sales
applies_to:
  - src/contacts.ts
  - src/crm
  - src/cli/commands/crm.ts
owners:
  - ravi-dev
status: active
normative: true
---

# CRM

## Intent

The CRM domain is the entry point for Ravi's relationship-work rules across
contacts, accounts, opportunities, tasks, facts, pipelines, and their
relationships. Its durable data model remains anchored in the existing
`contacts/crm` contract.

This document is the domain umbrella. Narrow behavior belongs to the semantic
child spec that owns it.

## Boundaries

- CRM behavior MUST remain contact-anchored and MUST NOT create a competing
  identity, access-policy, chat, or session model.
- Data ownership, pipeline configuration, controlled effects, authorization,
  and CLI transport MUST remain separately discoverable concerns.
- Applicable specs are conjunctive. A narrower spec MAY add stricter rules but
  MUST NOT weaken another applicable contract; a conflict MUST be reconciled
  before behavior changes.

## Invariants

1. CRM state MUST NOT replace canonical contact identity, access policy,
   chats, sessions, messages, or platform identities.
2. CRM records and relationships MUST use stable identifiers; referenced
   entities MUST be resolved and validated before persistence.
3. CRM business-data writes MUST satisfy the audit and projection rules in
   `contacts/crm`.
4. Contact-linked CRM reads and writes MUST honor `contacts/authorization` and
   `contacts/crm/authorization` before disclosure or mutation.
5. Invalid input or an unresolved required reference MUST NOT partially mutate
   CRM state.
6. Durable CRM state MUST remain available across independent invocations.
7. Existing records MUST remain readable when an optional capability is
   introduced. Breaking changes require a versioned migration rule in the
   owning child spec.
8. Every CRM change MUST identify and satisfy every applicable owning spec.

## Specification Map

| Concern | Normative spec |
| --- | --- |
| Contact-anchored CRM data, projections, and events | `contacts/crm` |
| Pipeline and stage topology, movement, and audit | `contacts/crm/pipelines` |
| Pipeline metadata and engine consumers | `crm/pipeline` |
| Controlled CRM effects | `crm/facade` |
| CRM command interface and errors | `cli/crm` |
| Contact identity and visibility | `contacts`, `contacts/authorization`, `contacts/crm/authorization` |

## Validation

- Resolve this umbrella and every affected child through `ravi specs get`.
- Run the focused checks named by each affected child.
- Run CRM command, type, build, and generated-contract checks before merge when
  a public CRM surface changes.

## Known Failure Modes

- A narrow rule is placed in this umbrella and diverges from its child spec.
- A relationship stores an unresolved or wrong-kind identifier.
- A contact-linked lookup bypasses visibility as an internal CRM read.
- A public command changes while `cli/crm` remains stale.
