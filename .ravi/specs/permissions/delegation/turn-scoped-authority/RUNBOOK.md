---
id: permissions/delegation/turn-scoped-authority
title: "Turn Scoped Authority - Runbook"
kind: feature
domain: permissions
capability: delegation
feature: turn-scoped-authority
status: draft
normative: true
---

# Runbook

## Debug A Tool Denial

1. Identify the invocation:
   - session key;
   - prompt/turn id;
   - channel and chat id;
   - provider/runtime;
   - tool or CLI command requested.
2. Resolve the actor from persisted message metadata:
   - `actor_type`;
   - `contact_id`;
   - `platform_identity_id`;
   - raw sender provenance.
3. If actor is missing or unknown, inspect contact intake:
   - `platform_identities`;
   - `contacts`;
   - `contact_policies`;
   - `chat_messages.contact_id`;
   - `session_participants`.
4. Resolve agent capabilities for the executor agent.
5. Resolve actor direct grants and role grants.
6. Resolve surface constraints from chat, route, instance, project, session, and turn approval.
7. Recompute the intersection.
8. Compare the denied object with the effective capability set.
9. If the agent has the grant but the actor/surface lacks it, add the missing role/surface policy only after operator approval.
10. If a stale context still allows a revoked capability, revoke or refresh invocation contexts for that actor/session.

## Debug Unexpected Allow

1. Confirm whether the context is internal admin, automation, or user-initiated.
2. If user-initiated, check whether `canWithCapabilityContext` used live `isAgentSuperadmin(agentId)` as a bypass.
3. Check whether the context kind is a long-lived `agent-runtime` root reused across actors.
4. Check whether the cached context key omitted `contact_id` or actor authority version.
5. Check whether an observer rule grant was accidentally applied to the source session.
6. Check whether a role expansion used union instead of intersection.
7. Revoke the context if authority provenance cannot explain the allow.

## Grant A User Capability

Preferred flow:

1. Create or reuse a role with a narrow allow list.
2. Assign the contact to that role at the narrowest practical scope.
3. Add a chat or route constraint when the capability should be unavailable in public surfaces.
4. Run `permissions check` or the future delegated check command as the contact and chat.
5. Trigger a test turn and inspect trace provenance.

Avoid granting directly to broad agents as a fix for a user denial. That widens every actor using the agent.

## Grant A Narrow Delegation Override

Use an override when a specific group/agent is allowed to delegate one
capability even though the current contact lacks it directly.

1. Confirm the executor agent already has the normal capability, for example
   `agent:<agent-id> use tool:Bash`.
2. Prefer a surface override when the exception belongs to a group/chat:
   `chat:<chat-id> delegate_use tool:Bash`.
3. Use an agent override only when the exception belongs to that executor agent:
   `agent:<agent-id> delegate_use tool:Bash`.
4. For agent overrides, confirm the chat/surface still has a normal grant or
   surface override for the capability.
5. Trigger a new turn and inspect metadata:
   `actorOverrideCapabilityCount`, `surfaceOverrideCapabilityCount`, and
   `delegationOverridePrincipals`.

Do not use overrides for unknown actors or automations. Give automations their
own explicit `automation:<id>` grants.

## Revoke A Critical Capability

1. Revoke the role/direct relation.
2. Revoke or refresh active invocation contexts for the affected actor, chat, session, and agent.
3. Confirm no active context still contains the revoked capability.
4. Run a negative tool invocation test.

## Useful Queries

Find active contexts with broad agent-admin capability:

```sql
select agent_id, count(*) as contexts
from contexts
where revoked_at is null
  and (expires_at is null or expires_at > unixepoch())
  and capabilities_json like '%"permission":"admin"%'
  and capabilities_json like '%"objectType":"system"%'
  and capabilities_json like '%"objectId":"*"%'
group by agent_id
order by contexts desc;
```

Find messages without contact resolution:

```sql
select actor_type, count(*) as messages
from chat_messages
group by actor_type
order by messages desc;
```

Find session participants without contact resolution:

```sql
select owner_type, count(*) as participants
from session_participants
group by owner_type;
```
