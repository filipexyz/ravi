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

## Unit Tests

- Given an executor agent with `admin system:*`, when the actor has no delegated capability, `use tool:Bash` is denied for a user-initiated invocation.
- Given an executor agent with `use tool:*` and `execute executable:*`, when the actor has only `use tool:Bash` but no executable grant, Bash command execution is denied for the missing executable.
- Given an actor role grants `use tool:Bash` and `execute executable:git`, when the agent lacks `execute executable:git`, the effective capability does not include git.
- Given a chat/surface constraint lacks Bash, when both actor and agent allow Bash, Bash is denied in that chat.
- Given an actor grants `execute group:sessions_info` and the current surface has no grant, deny, or constraint for that command, `ravi sessions info` is allowed through actor inheritance.
- Given an actor grants `execute group:context_codex-bash-hook` and the current surface has no grant, deny, or constraint for that command, `ravi context codex-bash-hook` is allowed through actor inheritance.
- Given the same delegated `contextId` is reused for multiple scope checks, actor-inherited effective capabilities remain available and are not recomputed as an empty surface branch.
- Given the actor grants `execute group:<x>` and the current surface has `deny_execute group:<x>`, the command is denied.
- Given the actor lacks `execute group:<x>`, the command is denied even if the executor agent has it.
- Given `contact_policies.status=allowed` with no role/grant, no tool/executable/CLI/session/contact authority is produced.
- Given actor is unresolved, all authority-bearing checks deny except non-tool textual response delivery.
- Given a child context requests a capability not present in the effective parent invocation context, issuing the child context fails.
- Given an observer rule grants a task tool, the grant appears only in the observer context, not in the source invocation context.
- Given a cron job fires, the actor principal is `automation:<id>` or equivalent and not the last human speaker.
- Given `chat:<id> delegate_use tool:Bash`, an executor agent with `use tool:Bash`, and a resolved contact with no direct grant, Bash is allowed in that chat.
- Given `agent:<id> delegate_use tool:Bash`, an executor agent with `use tool:Bash`, a resolved contact with no direct grant, and no chat grant/override, Bash is denied by the surface branch.
- Given `agent:<id> delegate_use tool:Bash` and a normal chat grant for Bash, a resolved contact with no direct grant can invoke Bash through that executor agent.
- Given `delegate_use tool:Bash` but the executor agent lacks `use tool:Bash`, Bash is denied.
- Given actor is unresolved or automation, `delegate_*` human overrides do not add authority.
- Given `delegate_admin system:*`, the CLI rejects it and runtime override normalization ignores it if present in legacy data.
- Given a subject has `delegate_use tool:Bash`, `snapshotSubjectCapabilities` omits it and `snapshotSubjectDelegationOverrides` exposes it as `use tool:Bash`.

## Capability Freshness Tests

- Given a delegated denial for a missing surface grant, when the grant is
  created, the next turn of the same session allows the capability without
  daemon restart.
- Given a surface whose grants were revoked in bulk, the next denial
  diagnosis reports grant state `revoked` with the revocation batch, not
  `never_granted` (see `permissions/explain`).
- Given context metadata with stale capability counts, explain/denial tooling
  re-resolves current graph state instead of echoing the snapshot counts as
  live.
- Given a role membership added for the actor, the next turn's actor branch
  includes the role-expanded capabilities.

## Group Chat Regression Tests

- In one group session, contact A with role `trusted-dev` invokes `ravi sessions read`; it is allowed if the agent and actor allow it and the surface has no explicit deny/constraint for that command.
- In one group session with a surface constraint role that omits `ravi sessions read`, contact A with role `trusted-dev` is denied even when agent and actor allow it.
- In the next turn of the same group session, contact B with no role invokes the same tool; it is denied without resetting the session.
- A system interruption between contact A and contact B does not transfer contact A's authority to contact B or to the system event.
- If contact A asks for contact B's personal resource, the request denies unless contact B or an approved higher-scope policy grants target access.

## Superadmin Boundary Tests

- `agent:main admin system:*` does not allow a user-initiated invocation from an untrusted contact to execute Bash.
- `agent:<x> admin system:*` allows an internal admin context only when context kind/provenance is admin/internal.
- Actor `contact:<owner>` with explicit break-glass role can delegate `admin system:*` only when the invocation trace marks break-glass/admin-delegated mode.
- Revoking the actor's break-glass role prevents the next tool call from using cached admin authority.

## Runtime Trace Checks

Each authority-bearing allow/deny trace SHOULD include:

- context id and kind;
- executor agent id;
- actor principal type/id;
- contact id and platform identity id when resolved;
- chat/session/source;
- requested permission/object;
- agent capability decision;
- actor capability decision;
- actor override capability decision;
- surface capability decision;
- surface override capability decision;
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

Routes to broad agents:

```sql
select count(*) as active_routes_to_superadmin,
       count(distinct r.agent_id) as superadmin_agents_routed
from routes r
join relations rel
  on rel.subject_type = 'agent'
 and rel.subject_id = r.agent_id
 and rel.relation = 'admin'
 and rel.object_type = 'system'
 and rel.object_id = '*'
where r.deleted_at is null;
```

## CLI Acceptance

Future CLI should support a delegated check equivalent to:

```bash
ravi permissions check-delegated \
  --agent <agent-id> \
  --actor contact:<contact-id> \
  --chat <chat-id> \
  use tool:Bash \
  --json
```

Until that exists, tests MUST exercise the resolver directly rather than relying only on `ravi permissions check agent:<id> ...`, because agent-only checks are insufficient for delegated authority.
