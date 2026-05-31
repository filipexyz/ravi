---
id: a2a/auth
title: "A2A Authorization"
kind: capability
domain: a2a
capability: auth
tags:
  - a2a
  - authorization
  - credentials
  - rebac
  - agent-card
applies_to:
  - src/a2a/auth.ts
  - src/a2a/registry.ts
  - src/a2a/client.ts
  - src/a2a/server.ts
  - src/permissions/
  - src/runtime/credential-pool.ts
  - src/cli/commands/runtime-credentials.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# A2A Authorization

## Intent

A2A authorization defines how Ravi decides who may call or expose a remote
agent, which credential may be used, and how task access is scoped after the
initial call.

The public A2A protocol delegates authentication and authorization to standard
web mechanisms and to each agent implementation. Ravi therefore MUST own a
first-class policy layer above Agent Card metadata.

## Definitions

- `caller_principal`: the local human, agent, session, task, automation, or
  SDK client that initiated an A2A operation.
- `remote_agent_identity`: a registry entry plus the selected Agent Card,
  provider, interface, tenant, and trust metadata for the remote agent.
- `a2a_auth_binding`: a durable mapping from `remote_agent_identity` and remote
  security scheme to a Ravi credential reference, allowed scopes, owner
  principal or tenant, rotation state, and expiration policy.
- `delegation_policy`: the Ravi permission rule that allows a
  `caller_principal` to invoke a remote agent or skill with specific modes,
  artifact handling, and data boundaries.
- `auth_challenge`: a remote `401`, `403`, `WWW-Authenticate`, A2A
  input-required state, or equivalent response that requires new credentials or
  operator approval before retrying.
- `server_principal`: the authenticated external caller invoking a Ravi agent
  through Ravi's A2A server surface.

## Authorization Layers

Outbound A2A MUST pass these layers in order:

1. `discovery_trust`: the Agent Card is parsed, optionally signature-verified,
   and registered. Public card metadata is advisory only.
2. `registry_enablement`: an operator or trusted automation enables the remote
   agent, selects trust level, selected interface, allowed skills, and tenant
   constraints.
3. `caller_authorization`: Ravi permissions verify that the
   `caller_principal` may invoke the remote agent and requested skill.
4. `credential_binding`: Ravi resolves an enabled `a2a_auth_binding` compatible
   with the selected `securitySchemes`, `security`, and skill requirements.
5. `invocation_authorization`: the concrete request records policy version,
   caller principal, remote agent id, selected skill, credential reference id,
   non-secret credential fingerprint, scopes, and trace correlation.
6. `remote_challenge_handling`: remote auth failures become actionable pending
   auth events. The model MUST NOT be asked to paste or invent credentials.

Inbound A2A server exposure MUST pass:

1. `server_authentication`: authenticate the external client using declared
   Agent Card schemes.
2. `server_authorization`: authorize the external `server_principal` for the
   target Ravi agent, skill, task operation, and tenant/workspace boundary.
3. `task_scope`: task list, get, cancel, subscribe, and push configuration MUST
   be scoped to the authenticated caller before querying state that could leak
   resource existence.

## Rules

- Agent Card `securitySchemes`, `security`, and skill-level security
  requirements MUST be persisted as remote requirements, not as permission
  grants.
- A remote agent MUST be both enabled in the registry and allowed by
  delegation policy before any runtime invocation.
- The A2A client MUST NOT use raw URLs, arbitrary headers, prompt-supplied API
  keys, or ambient environment variables for runtime invocation.
- Credential resolution MUST use Ravi credential infrastructure by reference.
  Secrets MUST NOT appear in Agent Cards, prompt hints, traces, specs, logs,
  artifacts, or invocation rows.
- Each auth binding MUST declare its mode:
  - `service_account`: Ravi calls as a configured service/client identity.
  - `on_behalf_of`: Ravi calls with a user or tenant delegated credential.
  - `interactive_required`: Ravi cannot call until an operator/user completes
    an external auth flow.
- Least privilege is mandatory. A credential binding SHOULD be scoped to the
  smallest remote scopes, skills, tenant, and caller set that satisfies the
  use case.
- Extended Agent Cards MUST require authentication. Ravi MAY cache extended
  cards per credential binding or caller principal, but MUST redact sensitive
  fields from logs and prompt context.
- If an Agent Card carries signatures, verification SHOULD be required before
  raising trust above `untrusted`; failed verification MUST be recorded.
- Task access operations MUST enforce the original invocation authorization
  boundary. A caller that did not create or own an invocation MUST need an
  explicit admin/read permission to inspect or cancel it.
- Push notification callbacks MUST use HTTPS by default, bind callback
  credentials to one invocation/task or remote agent, validate callback
  authenticity, and apply SSRF protection to configured callback URLs.
- `401` and `403` MUST be represented distinctly: missing/invalid credentials
  versus valid credentials without permission. Both MUST be audited.
- Auth challenges MUST stop automatic retries until credentials or policy have
  changed. Retrying with the same failing credential SHOULD be rate-limited.
- Inbound server endpoints MUST perform authorization before database queries
  that reveal task, context, artifact, or agent existence outside the caller
  boundary.

## Data Model

The implementation SHOULD introduce data equivalent to:

- `a2a_auth_bindings`
  - `id`
  - `a2a_agent_id`
  - `security_scheme_id`
  - `credential_ref`
  - `mode` (`service_account`, `on_behalf_of`, `interactive_required`)
  - `allowed_scopes_json`
  - `allowed_skill_ids_json`
  - `owner_principal_json`
  - `tenant_id`
  - `status` (`pending`, `active`, `expired`, `revoked`, `error`)
  - `expires_at`, `last_verified_at`, `last_error`
  - `created_at`, `updated_at`
- `a2a_invocations.auth_context_json`
  - caller principal summary
  - policy decision id/version
  - selected credential binding id
  - non-secret credential fingerprint
  - selected remote scopes and skill requirements
  - challenge/error status when present

## CLI And SDK Surface

The decorated CLI SHOULD expose:

```bash
ravi a2a auth bindings list --agent <agent-id> --json
ravi a2a auth bind <agent-id> --scheme <scheme-id> --credential <ref> --scopes <scope-list> --json
ravi a2a auth test <agent-id> --json
ravi a2a auth revoke <binding-id> --json
```

Runtime-facing send commands SHOULD accept an explicit authorization intent:

```bash
ravi a2a send <agent-id> "message" --skill <skill-id> --auth-mode service-account --json
ravi a2a send <agent-id> "message" --skill <skill-id> --auth-mode on-behalf-of --json
```

If no compatible binding exists, the command MUST fail with a structured
`auth_required` result containing safe next actions, not a prompt-visible
secret request.

## Acceptance

- A registered remote agent cannot be invoked until it is enabled and has an
  allowed caller policy.
- An enabled remote agent cannot be invoked until a compatible credential
  binding exists or the remote operation is explicitly anonymous/public.
- Auth failures preserve HTTP status, challenge headers when safe, remote error
  code, remote agent id, selected scheme, and invocation id.
- The same remote task cannot be read, canceled, subscribed to, or configured
  for push by an unrelated caller without explicit permission.
- Extended Agent Card retrieval is authenticated and does not leak privileged
  metadata into public registry summaries.

## Known Failure Modes

- Treating successful credential resolution as sufficient permission.
- Letting a local model choose credential refs or paste secrets.
- Recording bearer tokens or API keys in `card_json`, `auth_context_json`, logs,
  or prompt hints.
- Allowing remote task enumeration across tenants because `contextId` was
  omitted.
- Reusing one broad service credential for every remote agent and skill.
- Accepting push callback URLs that target private network addresses.
