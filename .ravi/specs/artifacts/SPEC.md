---
id: artifacts
title: "Artifacts"
kind: domain
domain: artifacts
capabilities:
  - async-generation
  - lifecycle-events
  - session-notification
  - ui-artifacts
tags:
  - artifacts
  - async
  - lineage
  - generative-ui
applies_to:
  - ravi artifacts
  - ravi image
  - generated files
  - long-running media jobs
  - .ravi/specs/artifacts/ui
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

- Artifact `kind` is a semantic classification, not the artifact storage
  primitive. It MUST NOT be required from the human CLI create flow.
- Generic artifact creation SHOULD work without an explicit `kind`; the system
  MAY store a conservative fallback kind such as `artifact` for compatibility.
- Callers MAY provide `kind` explicitly when they need semantic filtering,
  task-profile matching, or producer-specific classification.
- Content shape MUST be derived from the content itself. A single local file,
  local directory/package, URI-only reference, and structured output are content
  shapes, not mandatory artifact kinds.
- Local directory/package ingestion MUST copy package files into the artifact
  blob store and MUST reject symlinks, traversal paths, hidden path segments, and
  reserved `_ravi` segments.
- Publishability MUST be determined from version assets and manifests, not from
  `artifact.kind`.
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
- Reusable or inspectable UI objects MAY be artifacts. UI catalogs, component
  contracts, UI specs, selected patch streams, and debug renders are valid
  semantic artifact kinds when they need versioning, lineage, review, preview,
  rollback, replay, or audit.
- Runtime UI implementations MUST NOT treat every DOM node, transient patch, or
  hover/focus state as an artifact. Artifacts represent durable UI objects, not
  every surface-level render operation.
- Generated UI artifacts MUST preserve the same lineage guarantees as media or
  report artifacts: source session/agent/channel/message when available, source
  event or artifact when applicable, and producer metadata.
- A service that produces an artifact SHOULD be able to notify the owner session
  when the artifact reaches a terminal state.
- Generated media requested from a chat context SHOULD be delivered back to the
  origin chat automatically when the artifact completes.
- Synchronous generation MAY continue to exist, but it SHOULD still use the same
  artifact lifecycle internally.

## Versioning

- Artifacts MAY have immutable versions.
- A version MUST snapshot the artifact content locators that existed when the
  version was created, including local file/blob paths, MIME type, size, hash,
  URI, and structured manifest data when available.
- File/blob/URI/output updates SHOULD create a new version instead of mutating
  prior version rows.
- Metadata-only edits SHOULD NOT create a new version unless the caller
  explicitly requests a manual snapshot.
- Restoring an older version MUST NOT delete or overwrite version history; it
  MUST reapply the selected version to the current artifact and create a new
  version representing the restore.
- Version assets MUST use Ravi-relative asset paths and MUST NOT allow absolute
  paths or `..` traversal segments.

## UI Artifacts

Generative UI uses the artifact ledger as the durable object model for reviewed
and reusable UI work. The detailed contract lives in `artifacts/ui`.

Recommended UI artifact kinds:

- `ui.catalog`: allowed vocabulary of component ids, action ids, props schemas,
  slots, constraints, and generation guidance.
- `ui.component`: reusable component contract with semver, props schema,
  supported surfaces, fixtures, preview artifacts, and renderer references.
- `ui.spec`: concrete JSON UI tree that composes catalog components.
- `ui.render`: rendered preview/debug snapshot for a specific surface.
- `ui.patch-stream`: persisted stream of JSON Patch-style operations, only when
  replay, audit, approval, or debugging value justifies persistence.

UI artifact specs MUST NOT embed arbitrary HTML, CSS, JavaScript, class names,
Tailwind classes, or remote bundles as generated content. Surface renderers own
implementation details and MUST validate generated specs before rendering.

## Event Types

Recommended event names:

- `created`
- `queued`
- `started`
- `provider_requested`
- `provider_processing`
- `file_saved`
- `blob_ingested`
- `version_created`
- `version_restored`
- `completed`
- `failed`
- `notified`

Artifact lifecycle events MAY also be projected onto Ravi event topics for app
UIs, overlays, and agents. Canonical lifecycle topics are:

- `ravi.artifacts.created`
- `ravi.artifacts.running`
- `ravi.artifacts.completed`
- `ravi.artifacts.failed`
- `ravi.artifacts.archived`

Event payloads SHOULD include artifact id, kind, status, version when known,
source session/agent/channel/message metadata when available, and the artifact
event id or timestamp for correlation.

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
ravi artifacts create --path ./output
ravi artifacts create --path ./output --kind report
ravi artifacts show art_...
ravi artifacts versions art_...
ravi artifacts version art_... --version 1
ravi artifacts snapshot art_... --label "before edit"
ravi artifacts restore art_... --version 1
ravi artifacts events art_...
ravi artifacts watch art_...
```

## Pages Publishing

Ravi Pages content publishing uses the artifact package/release pipeline
internally, but the user-facing command MUST be Pages-specific.

`ravi pages create/update/visibility/domains` manage the remote site record only.
They do not upload HTML, assets, or release content. A complete Pages upload uses
`ravi pages publish`, which packages a local directory/file or a local Ravi
artifact version, opens a Console upload session, uploads bytes, finalizes the
cloud artifact version, and activates a site release.

Canonical directory publish:

```bash
ravi pages publish <project-ref> <site-slug> ./site --route / --visibility public --entrypoint index.html
```

Canonical local artifact publish:

```bash
ravi pages publish <project-ref> <site-slug> <artifact-id> --route / --visibility public
```

Pages publishing MUST use `ravi pages publish` for the user-facing command.
`ravi artifacts publish` remains the generic primitive under the hood.

Synchronous generation remains available only when explicitly requested:

```bash
ravi image generate "..." --sync
```

## Validation

- `ravi artifacts show <id> --json` MUST show status, file/blob references, and
  lineage.
- `ravi artifacts versions <id> --json` SHOULD show immutable version snapshots
  and their assets.
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
