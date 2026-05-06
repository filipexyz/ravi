---
id: knowledge/profiles
title: "Knowledge Profiles"
kind: capability
domain: knowledge
capability: profiles
capabilities:
  - markdown-profiles
  - extraction-profiles
  - publication-profiles
tags:
  - knowledge
  - markdown
  - profiles
applies_to:
  - src/knowledge/profiles
  - .ravi/knowledge/profiles
owners:
  - ravi-dev
status: draft
normative: true
---

# Knowledge Profiles

## Intent

Knowledge profiles define how source material becomes draft knowledge and how canonical knowledge becomes readable output.

Profiles MUST be Markdown-first, following the same direction chosen for Observer Profiles.

## Source Layout

User/workspace profiles SHOULD live under:

```text
.ravi/knowledge/profiles/<profile-id>/PROFILE.md
.ravi/knowledge/profiles/<profile-id>/extract/*.md
.ravi/knowledge/profiles/<profile-id>/render/*.md
```

System profiles MAY be packaged under:

```text
ravi-system/knowledge/profiles/<profile-id>/
```

## PROFILE.md

`PROFILE.md` frontmatter SHOULD declare:

```yaml
id: workstream
title: Workstream Knowledge
version: 1
kind: extraction
itemKinds:
  - decision
  - risk
  - open_loop
  - win
threadStrategy: match-or-create
defaultStatus: draft
minConfidence: low
```

The Markdown body defines the human-readable contract:

- purpose;
- sources this profile is meant for;
- what to extract;
- what to ignore;
- confidence rules;
- redaction rules;
- output shape.

## Profile Kinds

Allowed profile kinds:

- `extraction`: source events/messages become draft items.
- `threading`: sources/items are assigned to semantic threads.
- `publication`: canonical items become notes/briefings.
- `briefing`: scoped context packets for agents or humans.

A profile MAY combine kinds, but implementations SHOULD keep extraction and publication separate when possible.

## Templates

Templates MUST be Markdown.

Templates MAY include simple placeholders, but they MUST NOT expose whole structured objects by default.

Allowed placeholder categories SHOULD be explicit:

- source scalar metadata;
- rendered source excerpts;
- item fields;
- thread fields;
- publication metadata;
- safe helper outputs.

Profiles MUST NOT allow arbitrary raw object dumps as the primary output.

## Preview and Validation

The CLI SHOULD support:

```bash
ravi knowledge profiles list
ravi knowledge profiles show <profile>
ravi knowledge profiles validate [<profile>]
ravi knowledge profiles preview <profile> --source session:<key>
```

Validation MUST catch:

- missing `PROFILE.md`;
- invalid profile id;
- invalid item kind;
- missing required template;
- unsupported placeholder;
- unsafe raw dump placeholder;
- frontmatter parse failure;
- publication profile without target shape.

## Snapshotting

When a curator or publisher runs with a profile, the run MUST persist a profile snapshot:

- profile id;
- version;
- source path;
- content hash;
- resolved templates;
- profile input variables.

This prevents future profile edits from rewriting historical interpretation silently.

## Standard Initial Profiles

Initial packaged profiles SHOULD include:

- `default`: general extraction.
- `life-review`: daily/weekly life-review extraction.
- `workstream`: objective, closure, unblock, risks, do-not-touch.
- `social-loops`: people, emotional weight, unanswered asks, suggested next step.
- `decisions`: decisions, reasons, alternatives, reversals.
- `state-base`: sleep, food, water, meds, body, house, energy.
- `vault-thread`: publication shape for long-running Obsidian notes.

## Acceptance Criteria

- A profile can preview a prompt/extraction result without writing.
- A profile can be updated without mutating past runs.
- Profile output is Markdown, not raw JSON or raw event dumps.
- A profile can reject extraction when confidence is too low.
- A profile can declare item kinds it is allowed to create.
