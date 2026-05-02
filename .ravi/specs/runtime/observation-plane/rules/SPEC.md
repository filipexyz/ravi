---
id: runtime/observation-plane/rules
title: "Observer Rules"
kind: feature
domain: runtime
capability: observation-plane
feature: rules
capabilities:
  - observation-plane
  - observer-rules
  - tag-selectors
tags:
  - runtime
  - observers
  - rules
  - tags
  - sessions
applies_to:
  - src/runtime
  - src/tags
  - src/tasks
  - src/cli/commands
owners:
  - ravi-dev
status: draft
normative: true
---

# Observer Rules

## Intent

Observer Rules define when Ravi creates or attaches observer sessions to a source session. Rules let operators and agents declare observation behavior once and have it apply consistently to new sessions, task sessions, or tagged work.

Rules are the policy layer for `runtime/observation-plane`. They decide which observers exist; the Observation Plane decides how matched observers receive events.

## Rule Model

An observer rule MUST have:

- stable `id`;
- `enabled` state;
- `scope`: `global`, `agent`, `session`, `task`, `profile`, `project`, or `tag`;
- selector criteria;
- observer agent or observer profile;
- optional observer runtime provider override;
- optional observer model override;
- optional observer profile id;
- observer mode: `observe`, `summarize`, `report`, or `intervene`;
- event filter;
- delivery policy;
- optional observer instructions;
- permission/capability grants for the observer session;
- priority;
- conflict behavior;
- audit metadata.

Rules SHOULD be stored in a DB-backed registry when they need runtime editing. Editable runtime state MUST have one authoritative source.

The initial Ravi distribution MUST NOT seed observer rules by default. A fresh system starts with zero observer rules and zero observer bindings. Operators, agents, or future profiles explicitly create rules when they want observation.

## Default Rule Values

When a rule is created without an explicit event filter, Ravi MUST use this default event set:

- `message.user`
- `message.assistant`
- `turn.complete`
- `turn.failed`
- `turn.interrupt`

The default event set is deliberately minimal but includes terminal source outcomes. Tool events (`tool.start`, `tool.end`) are available for explicit rules, but MUST NOT be enabled implicitly.

When a rule is created without an explicit delivery policy, Ravi SHOULD use `end_of_turn` so observers receive compact async batches and the source session does not wait.

`turn.interrupt` is the rule-facing event name for interrupted source turns. Implementations MAY accept legacy/internal aliases such as `turn.interrupted`, but stored rule state SHOULD normalize to `turn.interrupt`.

Observer instructions MAY be stored in rule metadata, such as `metadata.instructions`. These instructions MUST be delivered only to the observer prompt and MUST NOT affect the source session prompt.

Observer runtime provider and model MAY be stored directly on the rule. When absent, execution MUST inherit from the observer agent using the same runtime/provider and model fields used by `ravi agents set`. A rule-level runtime provider or model applies only to observer prompts created from that rule and MUST NOT change the observer agent or source session config.

Observer profile id MAY be stored directly on the rule. When absent, rendering SHOULD use the system fallback observer profile. A rule-level observer profile applies only to observer prompts created from that rule and MUST NOT affect rule matching, source event generation, or source session prompts.

## Matching

Rule matching happens when a source session is created and MAY be refreshed when relevant metadata changes.

Selectors MAY match:

- agent id;
- session key or prefix;
- task id;
- task profile;
- project id;
- route/chat/contact metadata when explicitly exposed;
- tags attached to agents, sessions, tasks, projects, contacts, or profiles.

A matched rule creates or reuses one observer binding. Binding creation MUST be idempotent.

Matching MUST be deterministic. For the same source session metadata, rule set, and tag set, Ravi MUST produce the same observer set.

## Tags as Rules

Tags are first-class selector input for observer rules. A tag is not only display metadata when used by a rule; it becomes part of runtime policy.

Examples:

```text
tag:task:auto-report
  -> attach task-progress-observer

tag:session:quality-watch
  -> attach quality-observer

tag:agent:cost-sensitive
  -> attach cost-observer

tag:project:memory-capture
  -> attach memory-observer
```

Tag selector rules MUST define:

- target type: `agent`, `session`, `task`, `project`, `contact`, `profile`, or `any`;
- tag slug;
- whether inherited tags apply;
- whether tag removal should detach, disable, or only stop future observer creation;
- priority relative to explicit non-tag rules.

Inherited tags MUST be explicit. A project tag MUST NOT automatically apply to every task/session unless the rule declares that inheritance.

Tag-driven rules MUST be auditable: operators must be able to explain which tag caused an observer binding.

## Rule Priority and Conflicts

Rules are evaluated by priority ascending, then stable id ascending.

Conflicts MUST be resolved deterministically. At minimum, conflicts include:

- two rules create the same observer role for the same source session;
- one rule disables an observer another rule enables;
- two rules grant incompatible delivery policies to the same observer binding;
- two rules grant different permission sets to the same observer binding.

The initial implementation SHOULD prefer explicit deny/disable rules over broad enable rules. Conflicts MUST be visible in validation output.

## Observer Identity

Rules SHOULD distinguish observer role from observer agent.

Example:

```text
role: task-progress
agent: task-reporter
provider: codex
model: gpt-5.4-mini
mode: report
```

Only one binding for the same source session and role SHOULD exist unless the rule explicitly allows multiples.

Observer runtime selection precedence MUST be:

1. rule/binding runtime provider and model;
2. observer agent provider and model;
3. global runtime defaults.

Rule validation MUST validate observer model selectors against the effective observer runtime provider, following the same model validation used by agent model configuration.

Observer prompt formatting precedence MUST be:

1. binding profile snapshot;
2. rule-selected observer profile;
3. system fallback observer profile.

Rules SHOULD reference profiles for substantial prompt formatting. Rule metadata instructions SHOULD remain short responsibility notes and MUST NOT replace profile event/delivery templates.

## Permission Grants

Rules MAY grant observer permissions, but only to the observer session/context. Rules MUST NOT grant tools to the source session.

Permission grants MUST be limited by observer mode. A rule with `observe` mode MUST NOT grant side-effecting tools. A rule with `report` mode MAY grant task/project reporting tools. `intervene` mode MUST require an explicit future policy.

## Lifecycle

Rules MAY apply:

- on source session creation;
- on task dispatch/recovery;
- on tag attachment/removal;
- on project/profile metadata changes;
- on operator replay.

Existing observer bindings SHOULD survive rule edits unless the operator requests reconciliation. Reconciliation behavior MUST be explicit: `future-only`, `attach-missing`, `detach-disabled`, or `full-reconcile`.

## Invariants

- Rules MUST be declarative. Runtime behavior MUST be explainable from stored rule state and source metadata.
- Rule matching MUST be deterministic and idempotent.
- Tags used as selectors MUST be auditable as policy inputs.
- Tags MUST NOT imply inheritance across agent, project, task, and session boundaries unless a rule declares that inheritance.
- Rules MUST NOT mutate source prompts, source permissions, or source session state.
- Rules MUST create observer bindings, not direct provider hooks.
- Rules MUST persist observer runtime provider/model with the binding so execution remains auditable and deterministic.
- Rules MUST persist observer profile resolution with the binding so prompt rendering remains auditable and deterministic.
- Disabled rules MUST NOT create new observer bindings.
- Rule validation MUST catch duplicate ids, invalid tag selectors, unknown observer agents/profiles, invalid observer profile ids, impossible modes, and unsafe permission grants.

## Validation

- `bun test src/runtime/observer-rules.test.ts`
- `bun test src/tags/tags.test.ts`
- `bun test src/tasks/service.test.ts`
- `bun run typecheck`
- `bun run build`

## Expected CLI Surface

The implementation SHOULD eventually expose:

```bash
ravi observers rules list
ravi observers rules show <id>
ravi observers rules set <id> <observer-agent> [--provider <runtime>] [--model <model>] [--profile <observer-profile>]
ravi observers rules enable <id>
ravi observers rules disable <id>
ravi observers rules validate
ravi observers rules explain --session <session>
ravi observers refresh <session>
```

`explain` MUST show matched rules, unmatched rules, selected tags, created bindings, skipped bindings, and conflicts.

`refresh` MUST apply the current rule set to an already-existing source session, creating missing bindings idempotently.

## Acceptance Criteria

- A global rule can attach a passive observer to every new source session.
- An agent-scoped rule can attach observers to every new session of that agent.
- A task-profile rule can attach a task reporter observer only to matching task sessions.
- A tag rule can attach an observer when a source session/task/agent has the configured tag.
- Removing or disabling a rule does not silently destroy existing observer state.
- Rule validation catches unsafe permission grants such as `observe` mode with task mutation tools.
- Rule explain can answer: "why did this observer appear on this session?"

## Known Failure Modes

- **Invisible policy**: a tag silently changes runtime behavior without explain output.
- **Tag overreach**: a project/contact tag unintentionally attaches observers to all descendant sessions.
- **Duplicate observer role**: multiple broad rules create redundant observers with the same responsibility.
- **Permission escalation**: a broad tag rule grants write tools to observers that should only observe.
- **Rule churn**: editing a rule unexpectedly deletes active observer state.
- **Non-determinism**: observer set changes depending on DB read order or unordered tag arrays.
- **Provider bypass**: a rule installs provider hooks instead of observer bindings.
