---
id: runtime/observation-plane/profiles
title: "Observer Profiles"
kind: feature
domain: runtime
capability: observation-plane
feature: profiles
capabilities:
  - observation-plane
  - observer-profiles
  - observer-prompt-rendering
tags:
  - runtime
  - observers
  - profiles
  - prompts
  - events
applies_to:
  - src/runtime
  - src/cli/commands
  - src/plugins/internal
owners:
  - ravi-dev
status: draft
normative: true
---

# Observer Profiles

## Intent

Observer Profiles define how observation events are rendered into prompts for observer sessions.

Rules decide when an observer exists. Profiles decide how each selected event and delivery envelope is described to that observer.

The capability exists so Ravi can experiment with observer prompt formats, A/B test observer responsibilities, and avoid exposing structured payload dumps as the observer-facing interface.

## Profile Model

An observer profile MUST have:

- stable `id`;
- `version`;
- human label and description;
- default event filter;
- default delivery policy;
- optional observer mode default;
- event template map;
- delivery envelope template map;
- optional renderer hints;
- audit metadata.

Profiles MUST be Markdown-only source bundles. The canonical workspace location is `.ravi/observers/profiles`.

```text
.ravi/observers/profiles/<profile-id>/
  PROFILE.md
  delivery/end-of-turn.md
  delivery/realtime.md
  delivery/debounce.md
  events/default.md
  events/message-user.md
  events/message-assistant.md
  events/turn-complete.md
  events/turn-failed.md
  events/turn-interrupt.md
  events/tool-start.md
  events/tool-end.md
```

`PROFILE.md` is the profile entrypoint. It MUST contain YAML frontmatter for machine-readable metadata and MAY contain human documentation in the Markdown body. Observer profile source MUST NOT use any non-Markdown manifest.

Example:

```markdown
---
id: task-reporter
version: "1"
label: Task Reporter
description: Observes a source task session and reports durable task progress.
defaults:
  eventTypes:
    - message.user
    - message.assistant
    - turn.complete
    - turn.failed
    - turn.interrupt
  deliveryPolicy: end_of_turn
  mode: report
templates:
  delivery:
    realtime: ./delivery/realtime.md
    debounce: ./delivery/debounce.md
    end_of_turn: ./delivery/end-of-turn.md
  events:
    default: ./events/default.md
    message.user: ./events/message-user.md
    message.assistant: ./events/message-assistant.md
    turn.complete: ./events/turn-complete.md
    turn.failed: ./events/turn-failed.md
    turn.interrupt: ./events/turn-interrupt.md
rendererHints:
  label: Task reporter
---

# Task Reporter

Human notes for operators can live here. Runtime rendering is driven by the
frontmatter and referenced Markdown templates.
```

The catalog SHOULD support the same source precedence pattern used by task profiles:

1. system profiles;
2. plugin profiles;
3. workspace profiles;
4. user profiles.

Editable runtime state MAY reference a profile id, but Markdown profile source files remain the source of truth for rendering behavior unless a future DB-backed profile editor is explicitly introduced.

## Template Types

Profiles MUST distinguish event templates from delivery envelope templates.

Event templates render one observation event at a time:

```text
events.message.user
events.message.assistant
events.turn.complete
events.turn.failed
events.turn.interrupt
events.tool.start
events.tool.end
events.default
```

Delivery templates render the final observer prompt for one delivery:

```text
delivery.realtime
delivery.debounce
delivery.end_of_turn
delivery.manual
```

Template names map to Markdown files by convention when omitted from frontmatter:

```text
events.message.user      -> events/message-user.md
events.message.assistant -> events/message-assistant.md
events.turn.complete     -> events/turn-complete.md
events.turn.failed       -> events/turn-failed.md
events.turn.interrupt    -> events/turn-interrupt.md
events.tool.start        -> events/tool-start.md
events.tool.end          -> events/tool-end.md
events.default           -> events/default.md
delivery.realtime        -> delivery/realtime.md
delivery.debounce        -> delivery/debounce.md
delivery.end_of_turn     -> delivery/end-of-turn.md
delivery.manual          -> delivery/manual.md
```

Frontmatter MAY override these paths, but every referenced template MUST be a Markdown file inside the same profile directory.

`events.default` MAY be used when no event-specific template exists. It MUST render readable Markdown and MUST NOT expose a raw structured dump as the primary representation.

`delivery.manual` MAY be absent until manual delivery is implemented. If absent, manual delivery MUST fail validation or use a documented system fallback.

## Rendering Pipeline

Rendering MUST happen in this order:

1. Resolve the observer profile for the binding.
2. Load the persisted profile snapshot from the binding when present.
3. Select observation events using the binding event filter and delivery policy.
4. Render every selected event with its event-specific template.
5. Render the delivery envelope with source metadata, binding metadata, observer role, delivery metadata, and the rendered event list.
6. Publish the rendered prompt to the observer session through the normal Ravi session runtime.

The renderer MUST NOT mutate source events, source prompts, source messages, source permissions, observer rules, or source session state.

Structured event payloads MAY be available to templates as placeholder context. The rendered observer prompt SHOULD expose concise human text first and raw details only when a profile explicitly asks for them.

## Template Context

Templates MUST use a strict placeholder renderer. Unknown placeholders MUST fail validation or preview instead of rendering silently.

Allowed context roots SHOULD include:

- `source`: source session, agent, task, project, route, chat, and command metadata that is explicitly permitted for observation;
- `binding`: observer binding id, role, mode, observer session, observer agent, and selected rule id;
- `profile`: observer profile id, version, label, source, and renderer hints;
- `delivery`: delivery policy, run id, event count, timestamp, and idempotency key;
- `event`: one compact observation event when rendering an event template;
- `events`: rendered event list and compact event metadata when rendering a delivery template;
- `input`: explicit profile input values, if supported later.

Templates MUST NOT receive unrelated chat/contact/session metadata by default.

## Snapshot and Determinism

Observer bindings SHOULD persist profile resolution data:

- `observerProfileId`;
- `observerProfileVersion`;
- `observerProfileSource`;
- `observerProfileSnapshotMarkdown`.

The snapshot is a canonical Markdown bundle containing `PROFILE.md`, resolved frontmatter, referenced template contents, and template hashes. It makes prompt rendering auditable and deterministic. Editing a profile SHOULD NOT silently rewrite existing binding behavior unless the operator requests explicit reconciliation.

Reconciliation behavior SHOULD mirror observer rules and be explicit: `future-only`, `attach-missing`, `refresh-profile`, or `full-reconcile`.

## Relationship to Rules

Observer rules MAY reference an observer profile. When a rule omits a profile, Ravi SHOULD use a system fallback observer profile.

Rules MAY still override event filters, delivery policy, mode, observer agent, runtime provider, model, and permission grants.

The effective event filter and delivery policy are resolved as:

1. rule override;
2. profile default;
3. system default.

The effective prompt formatting is resolved as:

1. binding profile snapshot;
2. current resolved profile;
3. system fallback profile.

Rules MUST NOT embed large prompt formatting text when a profile can own the formatting. Rule metadata instructions MAY remain for short observer-specific responsibility notes.

## System Profiles

The initial system observer profiles are:

- `default`: generic readable Markdown renderer for minimal observation.
- `tasks`: task-status renderer for sidecar observers that keep task progress, blocked, done, and failed states synchronized.

The `tasks` profile MUST keep status rules in Markdown templates, not in runtime code. It SHOULD instruct the observer to inspect current task state when needed, mutate task status at most once per delivery, and respond with a short observer-local status line.

`tasks` is intended to be selected by rules, especially a profile-scoped rule for source task profile `observed-task`. It MUST NOT create rules or bindings by itself.

## CLI Surface

The implementation SHOULD expose:

```bash
ravi observers profiles list
ravi observers profiles show <profile-id>
ravi observers profiles preview <profile-id> --event <event-type>
ravi observers profiles validate [profile-id]
ravi observers profiles init <profile-id> --preset <preset> --source workspace|user
```

Preview MUST render both event templates and delivery envelopes with representative source, binding, delivery, and event context.

Validation MUST catch missing required templates, invalid placeholder roots, unknown event template names, empty templates, and references to fields that are not in the allowed context.

Validation MUST also reject non-Markdown manifests, templates outside the profile directory, non-Markdown template paths, and missing `PROFILE.md`.

## Invariants

- Observer profiles MUST only control observer prompt rendering.
- Observer profiles MUST NOT control rule matching, runtime permissions, channel routing, or source session state.
- Observer profile source MUST be Markdown-only under `.ravi/observers/profiles`, plugin profile directories, or system profile bundles.
- Profile metadata MUST live in `PROFILE.md` YAML frontmatter.
- Observer profile source MUST NOT use non-Markdown manifests.
- Observer-facing prompts MUST be readable Markdown by default.
- Raw structured payload dumps MUST NOT be the default observer-facing representation.
- Event-specific templates MUST be independently customizable.
- Delivery envelope templates MUST be independently customizable per delivery policy.
- Profile rendering MUST be deterministic for the same profile snapshot, binding, source metadata, and event list.
- Profile validation MUST be strict enough to prevent silent prompt degradation.
- Profile changes MUST be auditable through profile source, version, and binding snapshot.

## Validation

- `bun test src/runtime/observation-profiles.test.ts`
- `bun test src/runtime/observation-plane.test.ts`
- `bun test src/cli/commands/observers-profiles.test.ts`
- `bun run typecheck`
- `bun run build`

## Acceptance Criteria

- A profile can render `message.user` without dumping a raw structured payload.
- A profile can render `turn.complete` differently from `turn.failed`.
- A profile can render `tool.start` and `tool.end` only when rules opt in to tool events.
- A delivery envelope can be customized separately for `realtime`, `debounce`, and `end_of_turn`.
- A rule can select an observer profile and produce a binding that stores profile resolution data.
- A binding with a profile snapshot renders the same prompt after the source profile file changes.
- Profile preview shows the final observer prompt and every event fragment used to compose it.
- Profile validation fails on unknown placeholders and missing required templates.

## Known Failure Modes

- **Structured prompt leakage**: implementation falls back to dumping raw event structures as the observer-facing prompt.
- **Prompt overreach**: profile templates include unrelated source/channel metadata by default.
- **Template mismatch**: a renamed event type no longer maps to an event template.
- **Silent blank output**: missing placeholders render as empty strings instead of failing validation.
- **Snapshot drift**: existing bindings unexpectedly change behavior after a profile edit.
- **Rule/profile confusion**: rules become large prompt templates instead of declarative matching policy.
