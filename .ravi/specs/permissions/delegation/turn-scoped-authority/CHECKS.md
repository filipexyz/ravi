---
id: permissions/delegation/turn-scoped-authority
title: "Turn Scoped Authority - Checks"
kind: feature
domain: permissions
capability: delegation
feature: turn-scoped-authority
status: draft
normative: true
---

# Checks

- `bun test src/runtime/runtime-request-context-lifetime.test.ts` MUST prove
  active renewal never adds grants, revocation wins, actor eligibility is
  revalidated and a terminal owner cannot renew its turn credential.

## Unit Tests

- In an ungoverned chat, a resolved contact with no independent grants MUST
  receive the executor's compartment-scoped agent identity bounded by turn
  caps; an empty surface capability set MUST NOT zero it.
- In a governed chat, missing contact grants MUST deny the capability; a
  covering contact grant MUST NOT exceed the executor ceiling.
- Given a contact grant for git but no executor capability for git, the
  effective context MUST omit git.
- `contact_policies.status=allowed` MUST NOT itself grant capabilities.
- Repeated scope checks MUST use the same effective invocation snapshot and
  MUST NOT reintroduce the retired actor/surface fallback formula.
- Given actor is unresolved, all authority-bearing checks deny except non-tool textual response delivery.
- Given a child context requests a capability not present in the effective parent invocation context, issuing the child context fails.
- Given an observer rule grants a task tool, the grant appears only in the observer context, not in the source invocation context.
- Given a cron job fires, the actor principal is `automation:<id>` or equivalent and not the last human speaker.
- Legacy `delegate_*` fixtures MUST NOT establish a production runtime path.
- `src/runtime/runtime-request-context.test.ts` and the user-overlay checks
  MUST exercise the active materialization contract.

## Admitted Console Actor Tests

- `src/access/delegated-actor.test.ts` MUST test verified caller, session,
  emitter, target and admission time; both preflight and header MUST resolve
  the same person and preserve the current executor agent.
- A hint, forged derived actor metadata, missing caller/admission, invalid
  time, cycle or wrong target MUST fail closed. A logged-in operator MUST
  NOT turn an unattributed relay into an allowed Console call.
- Normal completion/rotation and expiry after admission MUST retain the
  recorded person. Explicit revoke, removed grant, reduced profile and
  ineligible/opted-out contact MUST deny even after the caller rotated.
- `src/channels/slack/thread-delegated-actor.test.ts` MUST pass captured
  lifecycle prompts through queue/runtime context creation and access actor
  resolution, covering bootstrap, thread-send and reopen without replacing
  the producer's agent provenance or choosing a later human speaker.
- Personal connectors MUST remain refused for an otherwise verified agent
  relay; Knowledge MUST retain its existing turn eligibility contract.
- Pending/discovered group participants MUST retain resolved attribution
  without new capabilities; blocked/missing/opted-out contacts MUST fail.
- Real used-grant revocation after source rotation MUST deny both queued and
  materialized children without affecting a different contact or scope
  (`src/channels/slack/thread-delegated-actor.test.ts`).

## Capability Freshness Tests

- Given a denial for a missing agent capability or governed-chat grant, the
  applicable new grant MUST take effect on the next turn without restart.
- Given a surface whose grants were revoked in bulk, the next denial
  diagnosis reports grant state `revoked` with the revocation batch, not
  `never_granted` (see `permissions/explain`).
- Given context metadata with stale capability counts, explain/denial tooling
  re-resolves current graph state instead of echoing the snapshot counts as
  live.
- Given a new covering contact profile grant in a governed chat, the next
  turn MUST include its capabilities only within the executor ceiling.

## Group Chat Regression Tests

- In an ungoverned group, resolved contacts A and B MUST use the same agent
  identity ceiling while retaining distinct actor provenance.
- In a governed group, contact A with a covering grant MAY use an agent-held
  capability; contact B without that grant MUST be denied on the next turn
  without resetting the session.
- A system interruption between contact A and contact B does not transfer contact A's authority to contact B or to the system event.
- If contact A asks for contact B's personal resource, the request denies unless contact B or an approved higher-scope policy grants target access.

## Superadmin Boundary Tests

- An unresolved external actor MUST receive no agent identity authority even
  when the executor has `admin system:*`.
- Live executor admin status MUST NOT bypass the issued invocation snapshot.
- A contact's administrator status MUST NOT become agent tool authority;
  break-glass remains a separate, auditable operator path.
- Revoking applicable authority MUST prevent the next check from using cached
  administrator capabilities.

## Runtime Trace Checks

Each authority-bearing allow/deny trace SHOULD include:

- context id and kind;
- executor agent id;
- actor principal type/id;
- contact id and platform identity id when resolved;
- chat/session/source;
- requested permission/object;
- agent capability decision;
- agent identity compartment;
- governed-chat overlay decision when applicable;
- turn and caller-narrowing bounds when applicable;
- verified Console actor admission lineage when applicable;
- final effective decision;
- role ids and relation sources involved;
- stale/revoked context status.

## Database Health Checks

Contacts and platform identities:

```sql
select owner_type, channel, count(*) as identities
from platform_identities
group by owner_type, channel
order by identities desc;
```

Unknown actors in the ledger:

```sql
select actor_type, count(*) as messages
from chat_messages
group by actor_type
order by messages desc;
```

Broad active contexts:

```sql
select count(*) as active_contexts,
       sum(case when capabilities_json like '%"permission":"admin"%' and capabilities_json like '%"objectType":"system"%' and capabilities_json like '%"objectId":"*"%'
                then 1 else 0 end) as admin_contexts
from contexts
where revoked_at is null
  and (expires_at is null or expires_at > unixepoch());
```

Routes to broad agents MUST be audited through provider-runtime
materialization:

```bash
ravi permissions materialize --subject-type agent --subject-id <agent-id> --json
```

## CLI Acceptance

Tests MUST exercise runtime context creation and the relevant actor resolver,
not infer successful Console attribution from an agent-only capability check,
trace label or root-card requester name. Inspection of the effective context
and `resolveAccessActor` MUST agree with the preflight/header outcome.
