---
id: work-objects
title: Work Objects
kind: domain
domain: work-objects
status: active
normative: true
owners:
  - ravi-dev
capabilities:
  - adapters
  - sdk-gateway
  - nats-transport
  - task-integration
tags:
  - work-objects
  - adapters
  - sdk
  - nats
applies_to:
  - src/work-objects
  - src/cli/commands/work-objects.ts
  - src/daemon.ts
  - packages/ravi-os-sdk
---

# Work Objects

Work Objects are Ravi's generic, channel-neutral representation of durable
domain entities that can be previewed, inspected, edited, or acted on from
external surfaces.

## Boundaries

- Work Objects MUST be domain-first. Slack, Omni, dashboard, and other callers
  are transports or renderers, not the source of truth.
- Domain adapters MUST own domain mapping, validation, authorization hooks, and
  mutation semantics for their entity type.
- Transport adapters MUST NOT contain task, artifact, page, or session business
  logic.
- The initial task adapter MUST use the existing task service and task DB APIs.
  It MUST NOT create a parallel task store.
- Work Object IDs MUST remain provider-owned external references. Callers SHOULD
  pass `{ type, id }` and MAY also pass a URL that resolves to such a reference.
- Mutations MUST return structured field errors when a requested field or state
  transition is not supported.

## Contract

The Work Object service MUST expose these operations:

- `resolve`: turn a URL or external reference into a renderable Work Object.
- `update`: apply a structured patch to an existing Work Object.
- `action`: execute one named command against a Work Object.
- `suggest`: return selectable options for a field.

The contract SHOULD be reusable by:

- channel integrations through Omni/NATS;
- the Ravi SDK Gateway and generated SDK;
- dashboard/front-end surfaces;
- agents and internal automations.

## Security

- Public HTTP callers MUST go through the SDK Gateway and its command access
  enforcement.
- NATS callbacks are daemon-internal transport. They MUST remain generic and
  SHOULD preserve actor/channel metadata for audit and future authorization.
- Domain adapters SHOULD attribute mutations to the resolved actor/session when
  the caller provides this context.

## MVP

The first supported adapter is `task`.

Task Work Objects MUST support:

- resolve by `{ type: "task", id }`;
- resolve by URL patterns containing `/tasks/<id>`, `/task/<id>`, or
  `/work-objects/task/<id>`;
- fields aligned with common task work-object renderers: `description`,
  `created_by`, `date_created`, `date_updated`, `assignee`, `status`, and
  `priority` when the source task has those values;
- editable `description`, `status`, `priority`, and `progress` fields when the
  task runtime can apply the mutation safely;
- comments;
- progress reports;
- terminal state actions for done, blocked, and failed;
- archive and unarchive actions;
- static suggestions for task status and priority.

## Renderer Compatibility

- Adapters MAY include renderer-friendly hints such as `tag_color`, `format`,
  `link`, `edit`, `actions`, `displayOrder`, and `customFields`.
- Adapters MUST keep these hints channel-neutral. They MUST NOT emit Slack-only
  field names such as `entity_payload`, `slack_file`, or `slack#/types/*`.
- Channel integrations are responsible for translating the generic Work Object
  contract into platform-specific schemas.
