---
id: knowledge/why
title: "Ravi Knowledge Why"
kind: domain
domain: knowledge
status: draft
normative: false
---

# Why Ravi Knowledge Exists

## Problem

Ravi already has many places where important context appears:

- WhatsApp and other channel messages;
- runtime sessions;
- task reports;
- life-review files;
- artifacts;
- project state;
- specs;
- commits and PRs;
- observer summaries;
- ad hoc notes.

The current failure mode is not lack of memory. It is memory confetti.

The same idea can appear in a chat, a task, a spec, a daily review, and a system inform. Agents then re-read the wrong layer, duplicate extraction work, or miss the canonical version.

## Decision

Create `Ravi Knowledge` as the canonical semantic layer.

The core product is `ravi knowledge`.

The domain should be called `Knowledge Layer`, not `Vault`, because the vault is only one interface.

## Why Not Just Obsidian

Obsidian is excellent as a human reading and editing surface.

It is not enough as the canonical system of record because:

- it cannot represent every Ravi source with typed provenance;
- concurrent agents can corrupt notes without locks;
- file names are not stable semantic ids;
- manual edits and generated sections need boundaries;
- permissions, redaction, and audit need Ravi context;
- agent briefs need scoped reads, not arbitrary vault search.

So Obsidian should be a publisher adapter. Ravi owns the canonical model.

## Why Not Just Sessions

Sessions are runtime state. They are optimized for interaction and provider continuity, not semantic memory.

A topic can span:

- many sessions;
- many chats;
- multiple agents;
- tasks and projects;
- weeks of life-review output.

Treating a runtime session as the topic creates the wrong abstraction and makes knowledge disappear when the runtime changes.

## Why Not Just Tags

Tags classify assets. They do not hold evidence, decisions, summaries, or source lineage.

Knowledge uses tags for discovery, but the knowledge item/thread model owns semantic content.

## Why Curator Agents

Specialized agents can extract better knowledge if they have narrow attention:

- social loops;
- workstreams;
- decisions and wins;
- open loops;
- state-base;
- project context.

But curators should draft. A separate publisher/canonicalizer should merge, review, and publish to avoid five agents writing five conflicting notes.

## Tradeoff

This adds another domain to Ravi.

The cost is justified only if it reduces redundancy and prompt bloat. The implementation must therefore ship with idempotency, deduplication, source lineage, and bounded brief generation from the first version.
