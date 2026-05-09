---
id: contacts/profile-card
title: Contact Profile Card
kind: capability
domain: contacts
capability: profile-card
tags:
  - contacts
  - profile
  - timeline
  - agents
applies_to:
  - src/contacts.ts
  - src/cli/commands/contacts.ts
  - src/session-trace
owners:
  - ravi-dev
status: draft
normative: true
---

# Contact Profile Card

## Intent

The contact profile card is the operator-facing summary of what Ravi knows about one canonical contact.

It MUST be built from Ravi contact concepts: `contact`, `platform_identity`, `contact_policy`, `contact_event`, scoped metadata, chat/session actor metadata, and provenance. It MUST NOT treat raw Omni ids as the primary model.

The first target contact is Luis, but the feature MUST be generic. A profile agent should receive a `target_contact_id` and the same workflow should work for any contact.

## Contact Profiler Agent

Ravi MAY run a generic `contact-profiler` agent.

The agent's job is to keep contact profile cards useful by reading contact activity and writing proposed or confirmed profile context.

Profile research SHOULD run as a Ravi task using the `contact-profile-research` task profile. A plain ad hoc session is allowed for debugging, but the product workflow is task-first:

```bash
ravi tasks create "Research contact profile" \
  --profile contact-profile-research \
  --agent contact-profiler \
  --input target_contact_id=<contact_id>
```

The task profile is the process contract: it pins inputs, artifacts, runtime defaults, session naming, sync protocol, and handoff rules.

`contact-profile-research` MUST NOT be embedded in Ravi's built-in system profile catalog. It SHOULD be installed as an operational user/workspace/plugin task profile so the workflow can evolve without shipping as core Ravi behavior.

The agent MUST:

- operate on an explicit `target_contact_id`
- read contact details, identities, policy, metadata, timeline, messages, sessions, and activity exposed by Ravi
- write outputs as contact timeline events and scoped metadata
- include source, actor, confidence, and evidence for every update
- scope non-global observations by `project`, `chat`, `session`, `agent`, `domain`, or `task`
- create proposed facts for weak evidence instead of silently mutating confirmed profile state

The agent MUST NOT:

- merge contacts automatically
- infer identity from display name alone
- write group-specific labels as global tags
- gain access to all contact timelines merely because it can subscribe to events
- overwrite confirmed operator-entered fields from low-confidence observations

## Task Profile Contract

`contact-profile-research` MUST:

- require `target_contact_id`
- default to proposal-only writes
- create a task workspace for research artifacts
- make `PROFILE_RESEARCH.md` the primary artifact
- collect evidence from `ravi contacts profile/messages/sessions/activity/timeline/metadata`
- keep low-level runtime/tool evidence behind explicit raw inspection
- require task lifecycle sync through `ravi tasks report|block|done|fail`

The profile SHOULD also expose optional inputs for evidence depth, write mode, scope, and external research policy.

## Card Shape

The card SHOULD expose these sections:

- Header: name, avatar, kind, operational status, tags, identities, primary channel, last interaction, interaction count
- Summary: short current summary from `profile.summary` or generated from recent evidence
- Roles: global roles plus scoped roles such as `project.role`, `group.role`, `relationship.role`
- Preferences: communication style, preferred channel, language, cadence, boundaries
- Focus: current projects, topics, tasks, and domains associated with the contact
- Relationship: route agent, sessions, chats, relevant permissions/tags
- Open loops: unresolved asks, pending decisions, follow-ups, and tasks
- Evidence: recent timeline events, messages, sessions, and proposed facts

## Metadata Keys

Profile-card metadata SHOULD use namespaced keys.

Global keys:

- `profile.summary`
- `profile.headline`
- `profile.preferred_name`
- `profile.language`
- `relationship.role`
- `relationship.trust_level`
- `communication.preferences`
- `communication.preferred_channel`
- `context.current_focus`
- `context.open_loops`
- `context.recent_topics`
- `context.important_projects`
- `context.agent_notes`

Scoped keys:

- `project.role` under `scope_type='project'`
- `group.role` under `scope_type='chat'`
- `agent.observed_preferences` under `scope_type='agent'`
- `crm.lifecycle` under `scope_type='domain'`

## Read Surfaces

The public CLI SHOULD remain under `ravi contacts`.

Required read surfaces:

```bash
ravi contacts profile <contact> [--limit <n>] [--json]
ravi contacts activity <contact> [--limit <n>] [--offset <n>] [--raw] [--json]
ravi contacts messages <contact> [--limit <n>] [--offset <n>] [--json]
ravi contacts sessions <contact> [--limit <n>] [--offset <n>] [--json]
```

These commands MUST resolve the target into a canonical contact before querying activity.
`contacts activity` SHOULD default to high-signal contact activity and reserve low-level runtime/tool/adapter events for `--raw`.

## Write Surfaces

The agent SHOULD write through existing contact timeline and metadata commands or their API equivalents:

```bash
ravi contacts note <contact> <text> --source agent --scope <type:id>
ravi contacts metadata set <contact> <key> <json-value> --source agent --scope <type:id>
```

Future API writes SHOULD preserve the same event model:

- `source='agent'`
- `actor_type='agent'`
- `actor_id='contact-profiler'`
- explicit confidence
- evidence with message/session/chat/task/artifact ids when available

## Acceptance Criteria

- A contact profile can be generated for Luis using only `target_contact_id`.
- The same command works for another contact without code changes.
- Profile reads include canonical contact data, platform identities, policy, metadata, recent timeline, recent messages, recent activity, and session summaries.
- Agent-produced updates are scoped and attributed.
- Weak inferences are proposals, not confirmed state.
- Permissions can prevent unrelated agents from reading every contact profile.
