---
id: knowledge/runbook
title: "Ravi Knowledge Runbook"
kind: domain
domain: knowledge
status: draft
normative: false
---

# Ravi Knowledge Runbook

## Inspect a Thread

```bash
ravi knowledge threads show <thread-id-or-slug>
ravi knowledge items list --thread <thread-id-or-slug>
ravi knowledge sources show <source-id>
```

Check:

- thread status;
- last signal;
- canonical note URI;
- item count by kind/status;
- source coverage;
- stale items;
- pending draft items.

## Explain Why an Item Exists

```bash
ravi knowledge items show <item-id>
```

The output SHOULD include:

- item kind;
- confidence;
- evidence level;
- source links;
- extractor profile;
- curator or publisher actor;
- merge/supersession history.

If this cannot explain the item, the item is not ready to be canonical.

## Ingest a Session

```bash
ravi knowledge ingest --source session:<session-key> --profile default --dry-run
ravi knowledge ingest --source session:<session-key> --profile default
```

Use `--dry-run` first for large sessions.

Expected result:

- existing items reused or linked;
- new items created as draft unless auto-review is explicitly enabled;
- sources recorded;
- no raw transcript dumped into item bodies.

## Publish to Obsidian

```bash
ravi knowledge publish --adapter obsidian --thread <thread> --dry-run
ravi knowledge publish --adapter obsidian --thread <thread>
```

Check before write:

- target note path;
- managed block boundaries;
- manual content preservation;
- source frontmatter;
- diff preview.

If a note has manual edits inside the managed block, publisher SHOULD refuse or require `--force`.

## Fix Duplicate Items

1. Inspect the candidate duplicates.
2. Confirm source overlap and semantic equivalence.
3. Merge them.

```bash
ravi knowledge items merge <item-a> <item-b>
```

The merge MUST preserve all sources and append an audit event.

## Fix Wrong Thread Assignment

```bash
ravi knowledge items move <item-id> --thread <thread>
```

The move MUST record:

- previous thread;
- new thread;
- actor;
- reason when provided.

## Handle Bad Inference

If an item overstates an inference as fact:

```bash
ravi knowledge items update <item-id> --kind inference --confidence low
```

Then add a source/comment explaining why.

## Backfill a Time Window

```bash
ravi knowledge ingest --source session:main --since 2026-05-01 --until 2026-05-05 --profile workstream
ravi knowledge ingest --source life-review:2026-W18 --profile life-review
```

Backfills MUST be bounded. Avoid all-time ingestion without an explicit plan.

## Diagnose Missing Knowledge

Ask:

- Was the source ingested?
- Was the source visible to the profile?
- Did redaction remove the relevant content?
- Did the item merge into an existing canonical item?
- Did the item stay in draft?
- Was publication separate from canonical storage?

## Diagnose Vault Drift

If Obsidian does not match Ravi Knowledge:

1. Check the canonical thread.
2. Check latest publication record.
3. Run publisher dry-run.
4. Compare managed blocks.
5. Preserve manual sections.

The vault should be repaired from canonical knowledge, not the other way around unless an explicit import workflow is used.
