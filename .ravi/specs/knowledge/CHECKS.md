---
id: knowledge/checks
title: "Ravi Knowledge Checks"
kind: domain
domain: knowledge
status: draft
normative: false
---

# Ravi Knowledge Checks

## Storage and Idempotency

- Ingest the same session twice and verify no duplicate canonical items.
- Ingest overlapping source windows and verify source links merge.
- Merge two items and verify all source links remain attached.
- Mark an item stale and verify it remains visible in history.

## Thread Semantics

- Create one thread spanning two sessions, one task, and one artifact.
- Verify the thread id is stable even when session names change.
- Verify a runtime session is never used as the canonical thread id.
- Verify a closed thread can be reopened with a new signal.

## Evidence

- Create a fact with direct source evidence.
- Create an inference with confidence low.
- Create an absence-based item with inspected time window.
- Verify canonical items without sources are rejected unless `status=draft`.

## Identity Boundary

- Ingest a WhatsApp group message and verify the group is modeled as `chat`, not `contact`.
- Ingest a message with unresolved sender and verify it references `platform_identity`, not a guessed contact.
- Verify raw channel ids appear only in provenance/debug fields.

## Obsidian Publication

- Publish a thread to Obsidian twice and verify stable output.
- Add manual text outside the managed block and verify the publisher preserves it.
- Add manual text inside the managed block and verify dry-run detects drift.
- Verify frontmatter contains Ravi ids and source references.

## Profiles

- Validate every profile before use.
- Preview a profile against a small source batch.
- Verify profiles render Markdown, not raw structured dumps.
- Verify a profile can omit low-confidence items.

## Curator Agents

- Run two curators on the same source and verify they draft without conflicting writes.
- Verify only the publisher can mark items canonical by default.
- Verify curator sessions are bounded and linked to a knowledge thread.
- Verify curator agents cannot send outbound messages unless explicitly authorized.

## Privacy and Redaction

- Ingest a source containing credentials and verify redaction.
- Generate an agent brief and verify it includes only allowed sources.
- Publish to vault and verify sensitive raw payloads are not dumped.

## CLI

- `ravi knowledge threads list` is bounded by default.
- `ravi knowledge items list` supports cursor pagination.
- `ravi knowledge publish --dry-run` performs no writes.
- `ravi knowledge validate` catches orphan sources, duplicate slugs, missing profile templates, and publication drift.
