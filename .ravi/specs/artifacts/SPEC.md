---
id: artifacts
title: "Artifacts"
kind: domain
domain: artifacts
capabilities:
  - async-generation
  - lifecycle-events
  - session-notification
tags:
  - artifacts
  - async
  - lineage
applies_to:
  - ravi artifacts
  - ravi image
  - generated files
  - long-running media jobs
owners:
  - dev
status: active
normative: true
---

# Artifacts

## Intent

Artifacts are the durable object layer for generated outputs.

An artifact is not only a file record. For long-running generation flows, an
artifact MUST be usable as the live handle that represents the output before the
file exists, while it is being produced, and after completion or failure.

## Invariants

- Artifact creation for long-running generation SHOULD happen before provider
  execution starts.
- Async generation MUST return an `artifact_id` immediately once the handle is
  created.
- Artifact status MUST represent lifecycle state. Allowed core states are:
  `pending`, `running`, `completed`, `failed`, and `archived`.
- Every meaningful lifecycle transition MUST append an artifact event.
- Artifact events MUST preserve ordering, timestamp, source, event type, status,
  human-readable message, and structured payload when available.
- Provider calls, file writes, blob ingestion, session notifications, and failures
  SHOULD be represented as artifact events.
- A completed artifact MUST point to the final file/blob location when the output
  is local.
- A failed artifact MUST keep the error reason in an event and MUST remain
  inspectable.
- Artifacts MUST preserve lineage back to the requesting session, agent, channel,
  account, and source message when that context exists.
- A service that produces an artifact SHOULD be able to notify the owner session
  when the artifact reaches a terminal state.
- Generated media requested from a chat context SHOULD be delivered back to the
  origin chat automatically when the artifact completes.
- Synchronous generation MAY continue to exist, but it SHOULD still use the same
  artifact lifecycle internally.

## Event Types

Recommended event names:

- `created`
- `queued`
- `started`
- `provider_requested`
- `provider_processing`
- `file_saved`
- `blob_ingested`
- `completed`
- `failed`
- `notified`

## CLI Surface

The default async shape is:

```bash
ravi image generate "..."
```

Expected immediate result:

```json
{
  "artifact_id": "art_...",
  "status": "pending",
  "hint": "No polling needed: this artifact emits lifecycle events and will be sent to the origin chat when completed. Use watch/events only for manual inspection or debugging.",
  "autoSend": true,
  "watch": "ravi artifacts watch art_..."
}
```

Artifact inspection SHOULD support:

```bash
ravi artifacts show art_...
ravi artifacts events art_...
ravi artifacts watch art_...
```

Synchronous generation remains available only when explicitly requested:

```bash
ravi image generate "..." --sync
```

## Validation

- `ravi artifacts show <id> --json` MUST show status, file/blob references, and
  lineage.
- `ravi artifacts events <id> --json` SHOULD show the ordered timeline for the
  artifact.
- Async image generation SHOULD return before provider completion and still
  produce a terminal artifact event later.

## Known Failure Modes

- CLI blocks on provider generation and the agent has no durable object to track.
- A generated file exists but was never registered in artifacts.
- An artifact exists but has no event trail explaining how it was produced.
- A provider call fails and the failure disappears into command output instead of
  being persisted.
- The owner session never receives a completion/failure update.
