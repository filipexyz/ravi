---
id: knowledge/publishers
title: "Knowledge Publishers"
kind: capability
domain: knowledge
capability: publishers
capabilities:
  - publication-adapters
  - materialized-views
  - idempotent-publishing
tags:
  - knowledge
  - publishers
  - vault
applies_to:
  - src/knowledge/publishers
  - src/artifacts
owners:
  - ravi-dev
status: draft
normative: true
---

# Knowledge Publishers

## Intent

Publishers materialize canonical knowledge into human or agent-facing surfaces.

They do not own truth. They render truth.

## Publisher Contract

Every publisher MUST:

- read canonical knowledge through the Knowledge service;
- render through a publication profile;
- support dry-run;
- be idempotent;
- preserve provenance;
- record a `knowledge_publication`;
- preserve manual content when the target supports manual edits;
- fail safely when target drift is unsafe.

## Publication Targets

Initial targets SHOULD include:

- `obsidian`: Markdown notes in a human vault.
- `life-review`: daily/weekly review files.
- `agent-brief`: scoped context packets for agents.
- `artifact`: archived report artifacts.
- `dashboard`: operational UI materialization.

## Managed Blocks

For editable Markdown targets, publisher output SHOULD use explicit managed blocks:

```markdown
<!-- ravi:knowledge:start thread=<thread-id> publication=<publication-id> -->
...
<!-- ravi:knowledge:end -->
```

The publisher MAY update content inside the managed block.

The publisher MUST preserve content outside the managed block.

If manual edits are detected inside the managed block, the publisher SHOULD refuse unless forced.

## Publication Records

Each publication record SHOULD include:

- `id`
- `target_type`
- `target_uri`
- `thread_id`
- `profile_id`
- `profile_snapshot_hash`
- `source_item_ids`
- `content_hash`
- `status`
- `published_by_type`
- `published_by_id`
- `published_at`
- `metadata_json`

## Locks

Only one publisher SHOULD write to the same target URI at a time.

Concurrent curators MAY draft items, but target publication MUST be serialized by target URI.

## Agent Briefs

Agent briefs are publications too.

They MUST be scoped by:

- requesting actor;
- target agent/session/task/project;
- allowed source visibility;
- token budget;
- time window;
- thread selection.

Briefs MUST NOT become unbounded memory dumps.

## Acceptance Criteria

- Publishing twice without changes produces the same output hash.
- Manual content outside managed blocks is preserved.
- Publication history can explain which items and profile produced a note.
- A failed publisher does not corrupt canonical knowledge.
- A publisher dry-run shows a readable diff or write plan.
