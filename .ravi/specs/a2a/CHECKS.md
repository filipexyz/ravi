# Checks

Use this checklist before implementing or reviewing A2A changes.

## Registry

- Remote agent rows are distinct from local `agents`.
- Agent Cards are fetched only through controlled discovery code.
- Discovery supports `/.well-known/agent-card.json`.
- Card version, interfaces, capabilities, skills, security schemes, and cache
  metadata are persisted.
- Secrets are stored through Ravi credential infrastructure, never in Agent Card
  JSON or specs.
- Agent Card security metadata is treated as a requirement to satisfy, not as a
  permission grant.
- Registry enablement is separate from caller authorization.

## Authorization

- Every outbound invocation verifies local caller permission and compatible
  credential binding before network I/O.
- Auth bindings reference credentials by id/ref and never expose raw token,
  secret, key, or private signing material.
- The invocation audit records caller principal, policy decision, selected
  skill, security scheme, credential binding id, and non-secret credential
  fingerprint.
- `401` and `403` produce distinct Ravi results and are audited distinctly.
- Auth challenges do not ask the model to paste or invent secrets.
- Extended Agent Cards require authentication and privileged content is not
  included in public summaries.
- Task list/get/cancel/subscribe/push config is scoped to the authenticated
  caller before state lookup.
- Push notification callbacks authenticate payloads and reject private-network
  callback URLs unless explicit dev policy permits them.

## Invocation

- Every outbound call records caller context id, caller agent id, caller session
  key when available, remote agent id, selected interface, protocol version,
  and remote task/context ids when returned.
- Streaming and push updates are correlated to the same invocation/task record.
- Remote artifacts are written to Ravi artifacts or stored as safe references.
- Remote update delivery into active sessions defaults to follow-up semantics.
- Immediate steering/interrupt behavior is explicit and audited.

## Server Exposure

- No Ravi agent is exposed through A2A unless explicitly enabled.
- Agent Cards for Ravi agents omit internal cwd, prompt text, context keys,
  raw provider ids, private tool names, and credentials.
- Inbound A2A requests use a synthetic A2A source and do not emit to WhatsApp or
  other channel surfaces unless the called agent intentionally does so through
  normal Ravi output controls.

## Validation Commands

```bash
ravi specs get a2a --mode full --json
ravi specs get a2a/registry --mode full --json
ravi specs get a2a/auth --mode full --json
ravi specs get a2a/client --mode full --json
ravi specs get a2a/server --mode full --json
```
