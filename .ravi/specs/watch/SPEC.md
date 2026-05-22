---
id: watch
title: "Watch"
kind: domain
domain: watch
capabilities:
  - connectors
  - console-provider
  - events
  - triggers
tags:
  - watch
  - triggers
  - automation
  - nats
applies_to:
  - src/cli/commands/watch.ts
  - src/watch
  - src/inbox
  - src/triggers
owners:
  - ravi-dev
status: draft
normative: true
---

# Watch

## Intent

Watches are durable event sources that observe external systems and publish
normalized Ravi events. Humans should be able to create a watch from any chat,
then attach ordinary triggers to the events that watch produces.

`ravi watch` is the creation and management surface. `ravi inbox` is the local
delivery path for watch events produced on the Console side.

## Definitions

- `watch`: a configured event source, such as one npm package or one GitHub
  repository.
- `connector`: an implementation that knows how to observe one provider, such
  as `npm` or `github`.
- `placement`: where the connector runs: `local`, `console`, or `auto`.
- `provider watch`: a Console-hosted watch backed by a provider integration,
  such as the Ravi GitHub App.
- `watch event`: normalized event emitted by a watch, independent of placement.
- `trigger binding`: a regular Ravi trigger subscribed to one or more watch
  event subjects.

## Placement

- A connector SHOULD run locally when it can observe the source safely and
  reliably from the user's machine.
- A connector SHOULD run in Console when it needs always-on hosting, webhooks,
  managed provider credentials, provider app installation, or network reachability
  that local Ravi cannot provide.
- `auto` placement SHOULD prefer local execution when the connector supports it
  and required credentials are available, then fall back to Console when the
  connector declares Console support.
- Local and Console placements MUST emit the same watch event contract.
- Console-produced watch events MUST arrive locally through inbox delivery.
- The public OSS contract for Console-hosted watches lives in
  `watch/console-provider`. Console private policy, provider secrets, webhook
  verification internals, billing, and product rules MUST remain outside this
  repo.

## Event Contract

Every watch event MUST have stable identity and enough context for triggers:

```ts
type WatchEvent = {
  version: 1;
  eventId: string;
  watchId: string;
  watchName?: string;
  connector: string;
  placement: "local" | "console";
  eventType: string;
  dedupeKey: string;
  subject: string;
  source: Record<string, unknown>;
  payload: Record<string, unknown>;
  links?: Array<{ label: string; url: string }>;
  sensitivity?: "public" | "private" | "restricted";
  occurredAt: string;
  createdAt: string;
};
```

`eventId`, `watchId`, `connector`, `eventType`, and `dedupeKey` MUST be stable
across retries. Connector-specific payloads MUST avoid secrets and unnecessary
raw content.

## NATS Subjects

Watch events MUST be published on normalized NATS subjects:

```text
ravi.watch.<connector>.<event-type>
```

Examples:

```text
ravi.watch.npm.package.version_published
ravi.watch.github.release.published
ravi.watch.github.pull_request.merged
```

The payload `subject` field MUST match the subject used for publication.

When a watch event is delivered through Console inbox, the inbox item
`eventType` SHOULD use the Console event namespace `watch.<connector>.<event>`,
for example `watch.github.pull_request.merged`. The local NATS subject remains
`ravi.watch.<connector>.<event>`.

Triggers MAY subscribe broadly with `ravi.watch.>` or narrowly to connector and
event subjects. Trigger filters SHOULD inspect payload fields such as
`watchId`, `source.repo`, `source.package`, or `eventType`.

## Inbox Boundary

Inbox is not a separate event product. Inbox is the local delivery box for watch
events that were produced outside the local process, especially in Console.

- Console watch runners MUST deliver watch events through inbox.
- The local inbox bridge MUST preserve watch event identity when publishing to
  NATS.
- All new Console-produced inbox items SHOULD be watch events.
- Non-watch inbox item types SHOULD be treated as legacy or explicitly
  documented exceptions.

## Trigger Creation From Chats

Ravi SHOULD make it easy to create triggers from the chat where the operator is
standing.

When a trigger is created from a watch command in a chat context, Ravi SHOULD:

- create or reference the watch;
- derive the trigger topic from the watch event subject;
- capture the current chat as the trigger reply source;
- create a normal `ravi triggers` record;
- show the watch id, trigger id, topic, and how to disable both.

The trigger system remains the execution mechanism. Watch does not invent a
second trigger runner.

## Acceptance Criteria

- `ravi watch connectors` lists available connectors and placements.
- `ravi watch create ...` creates a durable watch and prints trigger-ready
  topics.
- Local watches and Console watches emit the same watch event shape.
- Console-produced watch events arrive through inbox and publish normalized
  `ravi.watch...` subjects.
- Ordinary `ravi triggers` subscriptions can react to watch events and reply in
  the chat where the trigger was created.
