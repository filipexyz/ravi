---
id: knowledge/publishers/obsidian
title: "Obsidian Publisher"
kind: feature
domain: knowledge
capability: publishers
feature: obsidian
capabilities:
  - obsidian-vault
  - markdown-publication
tags:
  - knowledge
  - obsidian
  - vault
applies_to:
  - src/knowledge/publishers/obsidian
  - .ravi/knowledge
owners:
  - ravi-dev
status: draft
normative: true
---

# Obsidian Publisher

## Intent

The Obsidian publisher materializes Ravi Knowledge into a human-readable Markdown vault.

The agent or service may be called `ravi-vault`, but the canonical system remains `Ravi Knowledge`.

## Source of Truth

Obsidian is not the source of truth for Ravi Knowledge by default.

The default direction is:

```text
Ravi Knowledge -> Obsidian
```

Reverse import MAY exist later, but it MUST be explicit and audited.

## Configuration

The vault path MUST be configurable.

The domain spec MUST NOT hard-code a user-specific vault path.

Config SHOULD include:

- vault root;
- default notes directory;
- attachment directory;
- slug strategy;
- managed block behavior;
- frontmatter schema version;
- dry-run default for destructive changes.

## Note Types

Initial note types SHOULD include:

- thread note;
- person/contact context note;
- project/workstream note;
- daily knowledge digest;
- decision log;
- open loop list.

## Frontmatter

Published notes SHOULD include frontmatter similar to:

```yaml
ravi_type: knowledge_thread
ravi_thread_id: kth_...
ravi_thread_slug: ravi-knowledge-layer
ravi_publication_id: kpub_...
ravi_profile_id: vault-thread
ravi_profile_version: 1
status: active
confidence: medium
last_signal_at: 2026-05-05T15:44:00-03:00
sources:
  - type: session
    id: main
  - type: task
    id: task-...
tags:
  - knowledge
```

Frontmatter SHOULD be stable and machine readable.

## Body Shape

A thread note SHOULD include:

- current summary;
- active objective;
- last real closure;
- next unblock;
- key decisions;
- open loops;
- risks;
- source index;
- managed Ravi block;
- manual notes section.

## Manual Edits

Humans may edit Obsidian notes.

The publisher MUST preserve manual sections.

The publisher SHOULD update only managed blocks unless a profile explicitly owns the whole file.

## File Names

File names are presentation.

They MUST NOT be treated as canonical ids.

If a file is renamed, the note frontmatter or publication record MUST still link it to the same thread.

## Acceptance Criteria

- Publishing a thread creates a deterministic Markdown note.
- Re-publishing updates the managed block without deleting manual notes.
- A renamed file can still be resolved through frontmatter or publication records.
- A missing vault path fails with a clear setup error.
- The publisher can run in dry-run without touching files.
