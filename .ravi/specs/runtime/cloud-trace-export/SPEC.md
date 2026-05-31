---
id: runtime/cloud-trace-export
title: "Cloud Trace Export"
kind: capability
domain: runtime
capability: cloud-trace-export
tags:
  - runtime
  - traces
  - console
  - observability
  - local-first
applies_to:
  - src/runtime
  - src/session-trace
  - src/cloud-auth
owners:
  - ravi-dev
status: draft
normative: true
---

# Cloud Trace Export

## Intent

Cloud Trace Export mirrors selected local Ravi runtime trace events to a linked
remote control plane so Console can display agent execution, tool calls, usage,
and failures.

It MUST preserve local-first behavior. Local runtime traces remain in SQLite and
local execution does not depend on remote export success.

## Boundary

The OSS runtime owns canonical runtime events and local trace rows:

- `session_events`
- `session_turns`
- `session_trace_blobs`
- cost events and local metrics

The remote control plane owns cloud persistence, product UI, retention, billing,
and authorization policy.

The exporter MUST NOT know remote Postgres/R2 schemas beyond the public ingest
contract.

## Export Shape

The exporter SHOULD convert local trace rows into one bounded remote ingest
batch:

```json
{
  "session": {
    "sessionKey": "agent:main",
    "sessionName": "main",
    "runId": "run_...",
    "agentId": "main",
    "runtimeProvider": "codex",
    "provider": "codex",
    "projectRef": "optional-project-slug"
  },
  "turns": [
    {
      "turnId": "turn_...",
      "sourceTurnId": "turn_...",
      "sequence": 1,
      "userPromptSha256": "optional-local-hash",
      "systemPromptSha256": "optional-local-hash",
      "requestBlobSha256": "optional-local-hash",
      "status": "complete",
      "startedAt": "iso8601",
      "completedAt": "iso8601"
    }
  ],
  "events": [
    {
      "eventId": "session_event:123",
      "sourceTurnId": "turn_...",
      "sequence": 42,
      "eventType": "tool.started",
      "eventGroup": "tool",
      "provider": "codex",
      "model": "gpt-5.4",
      "safePreview": "shell ...",
      "safePayload": {},
      "occurredAt": "iso8601",
      "schemaVersion": 1
    }
  ],
  "toolCalls": [],
  "blobs": []
}
```

Required fields:

- `session.sessionKey` MUST be present.
- `session.runtimeProvider` MUST be present. The exporter SHOULD derive it from
  the turn provider, then event provider, then a local runtime-provider default.
  It MAY duplicate the same value in `session.provider`.
- Each exported turn MUST include a positive `sequence`.
- Local prompt/request blob hashes MAY be sent as `userPromptSha256`,
  `systemPromptSha256`, and `requestBlobSha256` on the turn. These are
  hash-only metadata, not remote blob references.
- Each exported event MUST include `eventId`, `eventType`, positive `sequence`,
  and `occurredAt`.
- Events and tool calls tied to a local turn SHOULD use `sourceTurnId` matching
  the exported turn.

## Blob Export Rules

Local `session_trace_blobs` are local-first storage records. They are not
Console blob references.

The exporter MUST NOT send top-level `blobs[]` entries for local blobs unless
the blob has first been uploaded or registered through a Console-approved blob
contract and has a remote `r2Key` or `blobRef`.

Until a remote blob upload contract exists, the default export MUST omit
top-level `blobs[]` or send an empty array, even when local turns reference
`request_blob_sha256`, `user_prompt_sha256`, or `system_prompt_sha256`.

Hash-only metadata MAY be preserved in safe turn/event payload fields, for
example:

- `requestBlobSha256`
- `userPromptSha256`
- `systemPromptSha256`

Full local blob content MUST NOT be uploaded inline. A future remote blob upload
path is a public Console/OSS contract change and needs explicit approval.

## Event Selection

Default export SHOULD include:

- `adapter.request` metadata and hashes, not full prompt by default;
- `message.user` preview;
- `message.assistant` preview;
- `tool.started`;
- `tool.completed`;
- approvals and denials;
- `turn.complete`;
- `turn.failed`;
- `turn.interrupted`;
- usage/cost facts.

Provider raw events MUST be opt-in and redacted.

## Export Efficiency

The exporter SHOULD maintain a local export cursor or trace-export outbox so
local trace TTL pruning cannot delete unexported accepted events without an
explicit policy decision.

Local installations often contain historical `session_events` rows from before
cloud trace export was enabled. The exporter MUST NOT replay an unbounded old
SQLite backlog to Console by default. When the export cursor is absent or
severely stale, the exporter SHOULD establish a bounded recent baseline:

- skip historical rows older than the configured recent window;
- advance the local export cursor to the baseline high-water mark;
- keep the skipped rows in local SQLite for local-first inspection;
- record cursor metadata with the skipped range and reason;
- export current and future rows from that baseline.

Explicit replay/backfill can be added later as an operator action. It MUST be
opt-in and bounded.

Trace export SHOULD send ordered batches per session or run. It MUST NOT call
the remote Data Plane once per token delta or once per tiny stream fragment.
The sync runner SHOULD enqueue and upload multiple bounded batches per tick when
catching up, because local events from different sessions may be interleaved and
single-batch ticks can starve recent sessions behind old history.

`assistant.delta` events SHOULD be coalesced before export unless a policy
explicitly requests raw stream retention. Terminal events, tool lifecycle
events, approvals, denials, errors, and usage facts MUST remain independently
visible.

When a blob already exists locally by hash, the exporter SHOULD avoid uploading
duplicate blob content. It MAY send hashes in safe metadata, but MUST NOT put a
hash-only local blob in top-level `blobs[]`.

## Failure Semantics

Export is asynchronous and best-effort unless a future enterprise policy
requires blocking behavior.

Failures MUST:

- be recorded locally;
- retry with backoff when retryable;
- never block provider event loop terminality;
- never discard local traces;
- never expose remote tokens in logs.

## Security

Cloud Trace Export MUST use existing cloud auth or managed runtime lease
credentials. It MUST NOT create a separate credential store.

The exporter MUST redact secrets before upload and SHOULD preserve hashes so the
remote can prove two payloads are the same without seeing full content.

## Acceptance Criteria

- A local runtime turn completes even when trace export is offline.
- A linked installation can export a bounded timeline for Console display.
- Tool calls are visible remotely with safe previews and status.
- Full prompt/tool blobs are exported only when policy allows.
- Remote export does not require the OSS runtime to know remote database
  internals.
