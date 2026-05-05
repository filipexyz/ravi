---
id: knowledge
title: "Ravi Knowledge"
kind: domain
domain: knowledge
capabilities:
  - canonical-knowledge
  - semantic-threads
  - vault-publication
  - curator-agents
tags:
  - knowledge
  - memory
  - sessions
  - obsidian
  - agents
applies_to:
  - src/knowledge
  - src/cli/commands/knowledge.ts
  - src/runtime/observation-plane
  - src/sessions
  - src/tasks
  - src/artifacts
  - src/tags
owners:
  - ravi-dev
status: draft
normative: true
---

# Ravi Knowledge

## Intent

Ravi Knowledge is the semantic layer that turns dispersed interactions into canonical, reusable knowledge.

It exists to reduce context redundancy, preserve decisions and learning, create topic-level continuity, and publish structured notes for humans and agents without making raw chats, sessions, or vault files the source of truth.

The product namespace SHOULD be `ravi knowledge`.

The technical name SHOULD be `Knowledge Layer`.

The term `vault` SHOULD describe one publication surface or human interface, not the whole domain.

The term `Knowledge Plane` SHOULD NOT be used until this layer becomes a central runtime substrate with event routing responsibilities comparable to the Observation Plane.

## Non-Goals

Knowledge is not a replacement for:

- raw event logs;
- session runtime state;
- task execution state;
- project state;
- contact identity;
- the artifact ledger;
- an Obsidian vault;
- long-term prompt stuffing.

Knowledge MUST NOT become a second copy of every message.

Knowledge MUST NOT model chats, groups, contacts, or sessions using ad hoc names. It MUST reference Ravi's canonical channel, contact, session, task, project, artifact, and tag systems.

## Core Thesis

The unit Ravi needs is not "a note" and not "a session".

The unit is a canonical knowledge item inside a semantic thread, with durable provenance back to source events and operational assets.

Raw interaction:

```text
message / session / task / artifact / commit / email / file
```

becomes:

```text
source -> draft extraction -> canonical knowledge item -> semantic thread -> publication / briefing / agent context
```

## Core Objects

### `knowledge_source`

A provenance pointer to something Ravi can audit.

Allowed source types SHOULD include:

- `message`
- `session`
- `session_turn`
- `task`
- `project`
- `artifact`
- `insight`
- `event`
- `file`
- `commit`
- `email`
- `calendar_event`
- `external_url`

Required fields:

- `id`
- `source_type`
- `source_id`
- `source_locator`
- `source_timestamp`
- `actor_type`
- `actor_id`
- `visibility`
- `hash`
- `metadata_json`
- `created_at`

Source locators MAY include raw provider ids only as provenance/debug data. Product logic MUST use Ravi-owned ids when they exist.

### `knowledge_item`

The smallest canonical unit of knowledge.

Recommended item kinds:

- `fact`
- `inference`
- `decision`
- `preference`
- `open_loop`
- `risk`
- `win`
- `lesson`
- `question`
- `todo_reference`
- `summary`
- `context_packet`

Required fields:

- `id`
- `thread_id`
- `kind`
- `title`
- `body_md`
- `status`: `draft`, `reviewed`, `canonical`, `stale`, or `archived`
- `confidence`: `low`, `medium`, or `high`
- `evidence_level`: `direct`, `inferred`, `absence`, or `operator_asserted`
- `source_count`
- `created_by_type`
- `created_by_id`
- `reviewed_by_type`
- `reviewed_by_id`
- `last_signal_at`
- `supersedes_item_id`
- `metadata_json`
- `created_at`
- `updated_at`

Every non-draft item MUST have at least one `knowledge_source` link.

### `knowledge_thread`

A durable semantic topic that can span many sessions, chats, tasks, projects, days, and agents.

Examples:

- `ravi-runtime-pool`
- `rapha-content-pipeline`
- `hapvida-growth-offsite`
- `trt-father-workflow`
- `life-review-state-base`

Required fields:

- `id`
- `slug`
- `title`
- `summary_md`
- `status`: `active`, `watch`, `blocked`, `closed`, `stale`, or `archived`
- `owner_type`
- `owner_id`
- `scope_type`
- `scope_id`
- `last_signal_at`
- `canonical_note_uri`
- `metadata_json`
- `created_at`
- `updated_at`

Knowledge threads MUST NOT be runtime sessions. A runtime session MAY be opened to curate a thread, but that session is only a work surface.

### `knowledge_profile`

A Markdown-first extraction or publication profile.

Profiles define how sources are interpreted, how items are drafted, and how publications are rendered.

Profiles are specified in `knowledge/profiles`.

### `knowledge_publication`

A materialized output created from canonical knowledge.

Publication targets MAY include:

- Obsidian notes;
- life-review files;
- daily/weekly briefings;
- agent context packets;
- project reports;
- task comments;
- dashboards;
- search indexes.

Publication targets MUST be idempotent and preserve provenance.

## Evidence and Confidence

Knowledge MUST distinguish facts, inferences, and absences.

Examples:

- "Luis explicitly asked for Observer Profiles" is `fact` with `direct` evidence.
- "State-base is invisible this week" is usually an `inference` or `absence`, depending on the source set.
- "Rapha seems emotionally frustrated" is an `inference`, not a fact.

Curators MUST label low-confidence readings instead of writing them as truth.

Absence is meaningful only when the inspected source window is explicit. A knowledge item based on absence MUST record:

- inspected sources;
- time window;
- expected signal;
- observed lack of signal.

## Deduplication and Canonicalization

The Knowledge Layer MUST reduce redundancy.

It MUST support:

- source hash based idempotency;
- item similarity checks;
- `same_as` links;
- `supersedes` and `superseded_by` relationships;
- merge events preserving all sources;
- stale marking when an item is no longer current.

If a curator sees the same decision in five sessions, the expected result is one canonical decision item with five sources, not five notes.

## Relationship to Sessions

Sessions are runtime conversations.

Knowledge threads are semantic continuity.

A knowledge thread MAY have one or more curation sessions, for example:

```text
knowledge:thread:ravi-runtime-pool
knowledge:curator:social-loops:2026-05-05
vault-thread:rapha-content-pipeline
```

These sessions MAY help agents reason and draft, but they MUST NOT be the source of truth for the knowledge state.

## Relationship to Observation Plane

Observation Plane is an ingestion source and event delivery mechanism.

Knowledge MUST NOT depend on raw provider events or observer prompt text. It SHOULD consume canonical observation events, session traces, task events, and artifact metadata through Ravi-owned abstractions.

An observer MAY draft knowledge items.

An observer MUST NOT publish canonical knowledge unless an explicit knowledge publisher role grants that authority.

## Relationship to Tags

Knowledge threads and items SHOULD be taggable through the canonical tags registry.

Tags remain inert labels. Any behavior that selects knowledge by tag MUST be explicit, explainable, and auditable under the `tags` spec.

Asset types:

- `knowledge_thread`
- `knowledge_item`
- `knowledge_source`
- `knowledge_profile`
- `knowledge_publication`

## Relationship to Identity and Channels

Knowledge MUST respect Ravi's identity model.

It MUST NOT create a contact from a display name, group name, raw phone number, WhatsApp JID, LID, Telegram id, or email string unless the contacts/identity graph write path resolves it.

Knowledge MAY reference:

- `contact:<contact_id>`
- `agent:<agent_id>`
- `chat:<chat_id>`
- `session:<session_key>`
- `platform_identity:<platform_identity_id>` when unresolved

Group chats and threads are chat containers, not people.

## Privacy and Redaction

Knowledge is higher leverage than logs, so privacy rules are stricter.

The system MUST:

- avoid raw transcript dumps by default;
- store source references before storing excerpts;
- redact credentials, tokens, secrets, and private identifiers unless explicitly allowed;
- keep outbound publication disabled by default;
- respect visibility and capability checks when generating agent briefs;
- make it possible to delete or hide a publication without deleting provenance.

## CLI Surface

The first public CLI SHOULD be:

```bash
ravi knowledge ingest --source session:<key> [--profile <profile>] [--thread <thread>]
ravi knowledge threads list [--status active] [--tag <tag>]
ravi knowledge threads show <thread>
ravi knowledge threads create <slug> --title "..."
ravi knowledge items list [--thread <thread>] [--kind decision]
ravi knowledge items show <item>
ravi knowledge items merge <item-a> <item-b>
ravi knowledge sources show <source>
ravi knowledge publish --adapter obsidian [--thread <thread>] [--dry-run]
ravi knowledge brief --for agent:<agent> [--thread <thread>] [--since 24h]
ravi knowledge validate
```

All listing commands MUST follow the bounded listing contract from `cli/listing`.

## Initial V1

V1 SHOULD ship as a conservative pipeline:

1. canonical storage for threads, items, sources, and publications;
2. Markdown knowledge profiles;
3. one Obsidian publisher adapter;
4. curator agents that draft, not publish;
5. one publisher agent or service that materializes notes;
6. explain/debug for "why is this item in this thread?";
7. bounded CLI previews and dry-runs.

## Acceptance Criteria

- A session can be ingested twice without duplicating canonical items.
- A thread can span multiple sessions, tasks, chats, and artifacts.
- An item always links to sources or stays in draft.
- A curator can draft a decision, but canonical publication requires publisher authority.
- Obsidian publication is idempotent and preserves manual notes outside managed blocks.
- Agent briefs include only allowed sources and never raw dumps by default.
- Raw Omni/channel ids appear only as provenance/debug data.
- A group chat is never modeled as a person.
- A merge preserves every source link.
- A stale item remains auditable instead of being silently overwritten.
