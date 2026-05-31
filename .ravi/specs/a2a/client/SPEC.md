---
id: a2a/client
title: "A2A Client Invocation"
kind: capability
domain: a2a
capability: client
tags:
  - a2a
  - client
  - tasks
  - artifacts
  - authorization
applies_to:
  - src/a2a/auth.ts
  - src/a2a/client.ts
  - src/a2a/types.ts
  - src/cli/commands/a2a.ts
  - src/artifacts/
  - src/runtime/context-registry.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# A2A Client Invocation

## Intent

The A2A client lets Ravi call registered remote agents programmatically and
track their remote tasks, outputs, artifacts, and async updates.

## Mapping

- Ravi caller context -> `a2a_invocations.caller_context_id`.
- Ravi caller session -> `a2a_invocations.caller_session_key`.
- Ravi thread or explicit subject -> A2A `contextId` when continuing a remote
  collaboration.
- Text prompt -> A2A `Message.parts[].text`.
- Structured payload -> A2A data part.
- Local file or Ravi artifact -> A2A file part or safe URL reference.
- Remote task id/context id -> durable `a2a_invocations` fields.
- Remote artifacts -> Ravi artifact rows or safe external artifact references.

## Rules

- The client MUST resolve targets by `a2a_agents.id`; it MUST NOT accept an
  arbitrary endpoint URL for normal runtime invocation.
- The target registry entry MUST be enabled before invocation.
- The client MUST enforce caller permission before sending a remote request.
  Permission SHOULD be object-scoped, such as
  `a2a.agent.invoke:<agent-id>` plus optional skill and tenant constraints.
- The client MUST resolve a compatible `a2a/auth` credential binding before
  sending any authenticated request. It MUST NOT fall back to raw environment
  variables or prompt-supplied headers.
- Anonymous/public remote calls MAY be allowed only when the Agent Card does not
  require authentication and the local caller is still authorized by Ravi policy.
- The selected remote skill, security requirement, credential binding id,
  non-secret credential fingerprint, caller principal, and policy decision MUST
  be stored on the invocation.
- The selected interface MUST be stored on the invocation. If multiple
  interfaces exist, Ravi SHOULD prefer JSON-RPC over HTTP for the first
  implementation unless the operator configured another binding.
- The client MUST send the negotiated A2A protocol version header when using
  HTTP bindings.
- The client MUST support non-streaming send, task polling, and cancellation in
  the first production client.
- Streaming and push notifications SHOULD be implemented only after task
  persistence and correlation are in place.
- Remote async updates delivered into a live Ravi session MUST default to
  follow-up behavior. `steer` or immediate interrupt behavior MUST be an
  explicit option and MUST be audited.
- Remote input-required states MUST not be silently answered by Ravi. They
  SHOULD surface as a pending task/user-input event for the caller session or
  an operator-selected continuation path.
- Remote authentication challenges MUST not be silently retried with the same
  failing credential. They MUST surface as structured `auth_required` or
  `auth_forbidden` results with safe next actions.
- Remote artifacts MUST be persisted before being summarized into prompt
  context. Prompt context SHOULD include artifact ids, names, media types, and
  short summaries, not raw bytes.
- A2A errors MUST be normalized into Ravi errors while preserving remote code,
  remote message, HTTP status, and task id when present.
- Retry policy MUST be conservative. The client MAY retry network failures, but
  MUST NOT blindly retry non-idempotent sends unless an idempotency key or
  message id makes the retry safe.

## CLI And SDK Surface

The decorated CLI SHOULD expose:

```bash
ravi a2a send <agent-id> "message" --wait --json
ravi a2a send <agent-id> "message" --stream --json
ravi a2a tasks show <invocation-or-task-id> --json
ravi a2a tasks cancel <invocation-or-task-id> --json
ravi a2a tasks list --agent <agent-id> --json
```

The command return schema MUST include:

- local invocation id;
- remote agent id;
- selected remote skill id when provided;
- selected credential binding id when a non-public scheme is used;
- selected protocol binding/version;
- remote task id and context id when available;
- normalized status;
- returned messages and artifact ids;
- timing and error metadata.

## Acceptance

- A registered trusted remote agent can be invoked from CLI and SDK without
  exposing raw credentials.
- A call without a compatible auth binding fails before network invocation with
  a structured auth result.
- A long-running task can be polled and canceled by local invocation id.
- Returned file/data artifacts are traceable in Ravi.
- The same remote context can be continued from a Ravi thread or explicit
  context id.

## Known Failure Modes

- Treating a remote response as a local assistant message without preserving
  remote attribution.
- Losing task ids, making cancellation and audit impossible.
- Retrying a non-idempotent remote send and causing duplicate work.
- Injecting remote artifacts as opaque URLs that expire before the caller can
  inspect them.
- Letting the model choose headers or credentials for an A2A request.
