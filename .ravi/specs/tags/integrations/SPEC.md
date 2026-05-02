---
id: tags/integrations
title: "Tag Integrations"
kind: capability
domain: tags
capability: integrations
capabilities:
  - cross-domain-tags
  - migration
  - policy-selectors
tags:
  - tags
  - integrations
  - migration
  - policy
applies_to:
  - src/tasks
  - src/projects
  - src/contacts.ts
  - src/artifacts
  - src/insights
  - src/runtime/observation-plane.ts
  - src/cron
  - src/triggers
  - src/hooks-runtime
  - src/commands
  - src/skills
  - src/prox
  - src/workflows
owners:
  - ravi-dev
status: draft
normative: true
---

# Tag Integrations

## Intent

This spec defines how tags should extend across Ravi domains after the unified
registry exists.

The integration goal is not "add tags everywhere". The goal is to identify
where tags unlock routing, observation, automation, search, retention, reporting,
or policy without duplicating storage semantics.

## Adoption Rule

A domain SHOULD adopt unified tags when at least one is true:

- users/operators need to group assets across that domain;
- runtime policy needs selectors for that domain;
- observers or automations need to match that domain;
- retention/cleanup needs classes beyond timestamps/status;
- reports need to find evidence or work by domain;
- current local `tags_json` exists and classifies Ravi-owned assets.

A domain SHOULD NOT adopt tags merely to replace structured fields such as
`status`, `priority`, `kind`, `profile_id`, `provider`, `model`, or timestamps.

## Domain Matrix

### Agents

Asset type: `agent`.

Tags SHOULD classify operational role, domain ownership, tier, and surface.

Benefits:

- inherited matching for observer rules;
- grouped model/runtime audits;
- skill/permission policy by role;
- operational inventory for main.

### Sessions

Asset type: `session`.

Tags SHOULD classify live context, surface, retention, and special observation
needs.

Benefits:

- direct observer rules;
- session cleanup by retention class;
- session search and next-work surfaces;
- main can reason about dev/main/support surfaces without name parsing.

### Tasks

Asset type: `task`.

Tags SHOULD classify work type, domain, risk, observation, review, retention,
and handoff state.

Recommended examples:

- `task.observed`
- `task.needs-review`
- `task.blocker-risk`
- `risk.high`
- `domain.runtime`

Benefits:

- observed-task can be selected by tags, profiles, or both;
- task automations can spawn follow-ups for tagged classes of work;
- observers can report progress without task instructions being embedded in the
  primary worker prompt;
- task retention/archival can be class-based.

### Task Profiles

Asset type: `profile`.

Tags SHOULD classify profiles by operational behavior, not by every setting.

Benefits:

- observer rules can attach to every task using a tagged profile;
- profile catalogs can be searched by capability;
- rollout can distinguish experimental vs core profiles.

### Projects

Asset type: `project`.

Tags SHOULD classify domain, tier, state, risk, and operating mode.

Benefits:

- project tags can be explicitly inherited by tasks/sessions;
- main can prioritize active projects without custom dashboards;
- project-scoped observers and automations can be declared once.

### Contacts

Asset type: `contact`.

Contact tags SHOULD move from legacy JSON fields toward unified bindings when
they classify real-world relationship or policy.

Recommended examples:

- `contact.vip`
- `contact.lead`
- `contact.internal`
- `policy.mention-only`
- `risk.sensitive`

Benefits:

- contact permissions can use the same tag registry as the rest of Ravi;
- routing and reply policy can become explainable;
- group/contact-specific observers can reason about relationship context.

Migration MUST be careful because contact tags currently participate in
permission checks. During migration, old and new reads MAY coexist, but policy
explain output MUST identify which source was used.

### Chats, Routes, and Instances

Target asset types: `chat`, `route`, `instance`.

Tags SHOULD classify surfaces and routing boundaries.

Recommended examples:

- `chat.dev`
- `chat.customer`
- `surface.whatsapp`
- `route.allowlist`
- `policy.closed`

Benefits:

- route policies can match semantic chat classes instead of raw ids;
- observers can be attached to operational chats;
- channel-specific behavior can be explained as tag-driven policy.

### Artifacts

Asset type: `artifact`.

Artifact tags SHOULD replace or bridge internal `artifacts.tags_json`.

Recommended examples:

- `artifact.image`
- `artifact.report`
- `artifact.evidence`
- `generated`
- `handoff`

Benefits:

- reports can retrieve evidence across sessions/tasks/projects;
- generated media can be grouped without parsing paths;
- cleanup can distinguish scratch outputs from durable artifacts.

### Insights

Asset type: `insight`.

Tags SHOULD classify learnings by domain, kind, actionability, and confidence
surface.

Recommended examples:

- `insight.bug`
- `insight.pattern`
- `insight.improvement`
- `learnable`
- `quality`

Benefits:

- main can search memory by operational class;
- recurring problems can be clustered;
- learning/skill synthesis can select relevant insights.

### Cron Jobs, Triggers, Hooks, and Task Automations

Target asset types:

- `cron_job`
- `trigger`
- `hook`
- `task_automation`

Tags SHOULD classify automation ownership, side effects, lifecycle, and risk.

Recommended examples:

- `automation.cleanup`
- `automation.reporting`
- `risk.external-message`
- `surface.internal`

Benefits:

- operators can audit automation groups;
- risky side-effecting automations can be reviewed together;
- main can disable or explain automation families;
- retention and housekeeping routines can be grouped.

### Observer Rules, Bindings, and Profiles

Target asset types:

- `observer_rule`
- `observer_binding`
- `observer_profile`

Tags SHOULD classify observer responsibility and operational mode.

Recommended examples:

- `observer.task-reporter`
- `observer.quality`
- `observer.main-report`
- `observer.cost`

Benefits:

- operators can list who is watching what;
- observer rules can be organized by responsibility;
- main can inspect observation coverage across dev/main sessions.

### Commands, Skills, and Skill Gates

Target asset types:

- `command`
- `skill`
- `skill_gate_rule`

Tags SHOULD classify capability family, surface, side-effect class, and runtime
dependency.

Recommended examples:

- `command.ops`
- `skill.system`
- `skill.media`
- `gate.runtime`
- `risk.external-call`

Benefits:

- skill discovery can be grouped semantically;
- skill gates can be audited by capability family;
- commands can be listed by operational category;
- future policy can allow/deny command families.

### Workflows

Target asset types:

- `workflow_spec`
- `workflow_run`
- `workflow_node`

Tags SHOULD classify workflow template, project/domain, release class, and
operational mode.

Benefits:

- workflow libraries can be searched by use case;
- workflow runs can roll up by domain/state;
- task creation from workflow nodes can inherit tags explicitly.

### Prox Calls

Target asset types:

- `call_profile`
- `call_request`
- `call_voice_agent`
- `call_tool`

Tags SHOULD classify call purpose, risk, compliance, and customer journey stage.

Recommended examples:

- `call.support`
- `call.sales`
- `call.billing`
- `risk.external-call`
- `policy.approval-required`

Benefits:

- call policies can be grouped and audited;
- high-risk call tools can require explicit approval;
- reports can track call outcomes by domain or journey.

### Specs

Asset type: `spec`.

Spec frontmatter tags MAY remain document metadata. If specs need to participate
in global search or policy, they SHOULD be mirrored to `tag_bindings` with
provenance `source=frontmatter`.

Benefits:

- specs can be discovered by domain/capability;
- projects can link relevant spec clusters;
- agents can retrieve normative context by tag.

### Devin Sessions

Asset type: `devin_session`.

Devin remote tags are external provider metadata. Ravi MAY mirror them into
`tag_bindings`, but MUST preserve provider provenance and SHOULD NOT assume Ravi
owns their lifecycle.

Benefits:

- Ravi can correlate external Devin work with tasks/projects;
- local queries can use the same tag language as internal sessions;
- reports can span Ravi and Devin workstreams.

## Migration Priority

Recommended order:

1. `task`, `project`, `profile` because they directly affect observed-task and
   main/dev orchestration.
2. `artifact` and `insight` because they improve evidence and learning.
3. `contact`, `chat`, `route` because they affect permissions and channel
   routing and need careful migration.
4. `automation` assets because they benefit from audit/enable/disable grouping.
5. `command`, `skill`, `skill_gate_rule` because they improve capability
   discovery and policy.
6. `prox` and external mirrors such as Devin after internal semantics are stable.

## Acceptance Criteria

- Every adopting domain has an asset type in the canonical list.
- Domain-native tag commands write canonical bindings.
- Existing local tag fields are either migrated, mirrored with provenance, or
  documented as external/local metadata.
- Any tag-driven behavior has an explain path.
- Inheritance behavior is explicit per consumer.
- Tag-driven policy never depends only on naming conventions.
