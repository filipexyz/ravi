---
id: tags
title: "Tags"
kind: domain
domain: tags
capabilities:
  - asset-classification
  - policy-selectors
  - cross-domain-index
tags:
  - tags
  - classification
  - runtime
applies_to:
  - src/tags
  - src/cli/commands/tags.ts
  - src/runtime/observation-plane.ts
  - src/router
  - src/tasks
  - src/projects
  - src/contacts.ts
  - src/artifacts
  - src/devin
  - src/specs
owners:
  - ravi-dev
status: draft
normative: true
---

# Tags

## Intent

Tags are Ravi's shared classification layer for operational assets.

Tags are inert labels. They do not carry behavior, roles, or policy state by
themselves.

When another subsystem references a tag as a selector, the stored consumer rule
owns the behavior. That consumer MUST be explicit, explainable, and auditable.

The goal is to let main, operators, agents, observers, automations, and CLIs ask
questions such as:

- which sessions are dev-facing?
- which tasks need observation?
- which contacts require careful routing?
- which artifacts are evidence for a report?
- which automations are cleanup jobs?
- which projects are hot or core?

without encoding that classification in names, free-text notes, one-off JSON
fields, or subsystem-specific conventions.

## Canonical Model

Internal Ravi-owned tags MUST use the unified tag registry:

- `tag_definitions`
- `tag_bindings`

`tag_definitions` owns the stable tag slug and global description.

`tag_bindings` owns the relationship between a tag and one asset.

Bindings are polymorphic:

```text
tag -> asset_type + asset_id
```

The same tag MAY be attached to many asset types. The same asset MAY have many
tags. Re-attaching the same `tag + asset_type + asset_id` MUST be idempotent and
MAY update binding metadata.

The registry MUST preserve:

- stable tag slug;
- human label;
- optional description;
- `kind`: `system` or `user`;
- tag metadata;
- binding metadata;
- actor/source that created or updated the binding when available;
- timestamps.

## Asset Types

The canonical asset type list SHOULD grow deliberately. Implementations MUST NOT
invent ad hoc spellings for the same concept.

Current first-class internal asset types:

- `agent`
- `session`
- `task`
- `project`
- `profile`
- `contact`

Target asset types for broader adoption:

- `chat`
- `route`
- `instance`
- `artifact`
- `insight`
- `workflow_spec`
- `workflow_run`
- `workflow_node`
- `cron_job`
- `trigger`
- `hook`
- `task_automation`
- `observer_rule`
- `observer_binding`
- `observer_profile`
- `command`
- `skill`
- `skill_gate_rule`
- `context`
- `call_profile`
- `call_request`
- `call_voice_agent`
- `call_tool`
- `outbound_queue`
- `outbound_entry`
- `spec`
- `devin_session`

When a domain exposes a native alias such as `ravi tasks tag`, the alias MUST
write to `tag_bindings` unless the spec explicitly marks the tag as external
provider metadata.

## Slugs and Namespaces

Tag slugs MUST be stable, lowercase, and machine-friendly.

Recommended namespace families:

- `domain.*` - product, client, or system domain.
- `function.*` - operational function or role.
- `surface.*` - channel, entrypoint, or user-facing surface.
- `state.*` - current activity/state classification.
- `tier.*` - operational importance.
- `risk.*` - risk or sensitivity class.
- `policy.*` - optional naming convention for labels often consumed by policy
  rules; the slug prefix has no behavior by itself.
- `task.*` - task-specific classification.
- `project.*` - project-specific classification.
- `contact.*` - CRM relationship classification.
- `chat.*` - chat/group/thread classification.
- `artifact.*` - output/evidence classification.
- `insight.*` - memory/learning classification.
- `automation.*` - cron, trigger, hook, or task automation classification.
- `observer.*` - observation-plane classification.
- `skill.*` - skill classification.
- `command.*` - Ravi command classification.
- `call.*` - prox calls classification.
- `retention.*` - cleanup/TTL class.

Dotted slugs are namespace conventions, not automatic hierarchy. Exact matching
MUST be the default. Prefix or namespace matching MAY exist, but any policy
consumer using it MUST declare that behavior explicitly.

## Policy Boundary

A tag is inert by default.

Attaching a tag MUST NOT silently change runtime behavior unless a stored rule,
permission, route policy, automation, observer rule, or other explicit consumer
references that tag.

Any subsystem that treats tags as policy input MUST expose:

- which tag matched;
- which asset carried the tag;
- whether the tag was direct or inherited;
- which rule consumed it;
- what behavior changed;
- what permissions, if any, were granted.

Examples of policy consumers:

- Observer Rules using `scope=tag`.
- Contact permissions using `read_tagged_contacts`.
- Permission policy materializers that turn explicit `policy.*` tag matches
  into REBAC `relations`.
- Future route policies using chat/contact/session tags.
- Future automations firing only for tagged tasks/projects.
- Future retention jobs pruning assets by retention tags.

Permission policy consumers MUST NOT check tags as ambient runtime authority.
They MUST materialize explicit permission graph edges before behavior changes.
Non-permission consumers MAY expose another documented, auditable policy object
when their domain does not grant tool, executable, app, CLI, session, contact,
or gateway authority.

`policy.*` tag bindings require stronger provenance than ordinary
classification tags. A policy binding MUST preserve trusted source, creator,
created context, binding id/version, and trust class. Re-attaching a policy tag
MUST NOT overwrite trust provenance silently.

## Inheritance

Tags MUST NOT imply inheritance across boundaries by default.

Each consumer MUST define its own inheritance graph and require explicit opt-in
when inherited tags can affect behavior.

Examples:

- An observer rule MAY opt in to inherited `project` or `task` tags for a source
  session.
- A route policy MAY opt in to `contact` tags when routing a DM.
- A task automation MAY opt in to `project` tags when reacting to child task
  events.

Inherited tags MUST be visible in explain/debug output.

## Local and External Tags

Subsystem-local JSON tag fields SHOULD be treated as migration debt when they
classify Ravi-owned assets.

Allowed exceptions:

- external provider tags that must be sent to or read from a third-party API;
- file frontmatter tags that are part of source documents;
- temporary compatibility fields during migration.

External/local tags MAY be mirrored into the unified registry, but the mirror
MUST preserve provenance so operators can tell whether the tag came from Ravi,
frontmatter, a provider, or a migration.

If a local tag influences Ravi behavior, it SHOULD be mirrored or bridged to
`tag_bindings` before an explicit consumer references it.

## Domain Responsibilities

Every domain that adopts tags MUST document:

- which asset type it uses;
- how target existence is validated;
- whether tags are direct, inherited, or mirrored;
- whether tags can drive policy;
- which CLI/API writes tags;
- how tags appear in explain/debug output;
- how tag changes are audited.

The tag registry owns storage and generic query behavior. Domains own their own
semantics.

## Target Registry

Generic tag writes MUST go through a central target registry instead of
duplicating resolution logic inside each CLI command.

Each target registry descriptor MUST define:

- canonical `asset_type`;
- preferred CLI flag name;
- how user input is normalized to canonical `asset_id`;
- how target existence is validated for attach;
- whether orphan lookup is allowed for search/detach cleanup.

`attach` MUST require an existing target unless a future domain spec explicitly
declares a virtual asset type.

`search` and `detach` MAY resolve missing targets to raw canonical ids so stale
bindings can be inspected and removed after the source asset was pruned.

Adding a new asset type SHOULD require adding one descriptor and any optional
domain-specific CLI alias. The generic CLI MUST also support a descriptor-driven
selector:

```bash
ravi tags attach <slug> --target <asset-type>:<asset-id>
ravi tags detach <slug> --target <asset-type>:<asset-id>
ravi tags search --target <asset-type>:<asset-id>
```

## CLI Surface

The generic CLI SHOULD support:

```bash
ravi tags create <slug> --label "..."
ravi tags list
ravi tags show <slug>
ravi tags attach <slug> --<asset-type> <id>
ravi tags detach <slug> --<asset-type> <id>
ravi tags search [--tag <slug>] [--<asset-type> <id>]
ravi tags search --target <asset-type>:<asset-id>
```

The generic CLI MUST avoid unbounded noisy output by supporting filters and
eventually pagination/limits.

Domain-specific CLIs MAY expose convenience aliases:

```bash
ravi tasks tag <task-id> <slug>
ravi artifacts tag <artifact-id> <slug>
ravi contacts tag <contact-id> <slug>
```

Those aliases MUST use the canonical registry unless explicitly documented as
external-provider tags.

## Events and Audit

Tag definition creation, update, removal, attach, detach, and metadata changes
SHOULD emit structured audit/runtime events.

At minimum, audit records SHOULD include:

- tag slug;
- asset type;
- asset id;
- actor/context;
- prior metadata when overwritten;
- new metadata;
- timestamp;
- reason when supplied.

Behavior consumers SHOULD include the matching tag in their own event payloads.

## Migration

Existing subsystem tag fields MUST NOT be migrated blindly.

Migration SHOULD happen domain by domain:

1. Identify whether the local tag is internal, external, or document metadata.
2. Define the canonical asset type.
3. Define slug normalization rules.
4. Backfill `tag_definitions` and `tag_bindings` with provenance metadata.
5. Update readers to query the unified registry.
6. Keep compatibility writes only while old CLIs or APIs still require them.
7. Remove or rename local tag fields after downstream consumers are updated.

## Invariants

- Tags MUST have one canonical internal registry.
- Tag-driven policy consumers MUST be explainable before they affect behavior.
- Inheritance MUST be opt-in per consumer.
- Tag slugs MUST be stable; labels/descriptions may change.
- Tag bindings MUST be idempotent.
- Domain aliases MUST not fork storage semantics.
- External provider tags MUST be marked as external, mirrored, or local.
- Unbounded tag listing/search MUST NOT become the default machine interface.

## Known Failure Modes

- A tag silently changes runtime behavior without explain output.
- Different domains store semantically identical tags in incompatible fields.
- A dotted slug is treated as hierarchy in one domain and exact text in another.
- Contact tags affect permissions while using a different storage layer from
  generic tags.
- A `policy.*` tag grants authority without a stored permission policy rule,
  dry-run, materialized relation, and explain output.
- Auto-tagging applies a policy tag that is consumed for authority without an
  explicit policy-rule opt-in to that auto-generated source.
- Provider tags and Ravi tags are mixed without provenance.
- A project tag accidentally applies to every task/session without explicit
  inheritance.
- Re-attaching a tag overwrites binding metadata unexpectedly.
- Large `tags search --json` output floods the requesting runtime.
