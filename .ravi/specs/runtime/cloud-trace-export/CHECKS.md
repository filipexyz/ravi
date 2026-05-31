---
id: runtime/cloud-trace-export
title: "Cloud Trace Export Checks"
kind: checks
domain: runtime
capability: cloud-trace-export
owners:
  - ravi-dev
status: draft
normative: true
---

# Checks

- Exporter is disabled or no-op when cloud auth is absent.
- Export failure does not block `turn.complete`, `turn.failed`, or
  `turn.interrupted`.
- Export payload includes `session.runtimeProvider`.
- Export payload includes positive `sequence` on every exported turn.
- Export payload preserves local turn hash metadata as `userPromptSha256`,
  `systemPromptSha256`, and `requestBlobSha256` without adding `blobs[]`.
- Export payload includes event id and positive sequence on every exported
  event.
- Provider raw export is opt-in.
- Secrets are redacted before upload.
- Local `session_trace_blobs` without remote `r2Key` or `blobRef` are omitted
  from top-level `blobs[]`.
- Hash-only local blob metadata may remain in safe payload fields.
- A generated payload with local `request_blob_sha256` / `session_trace_blobs`
  still passes the Console runtime-trace normalizer.
