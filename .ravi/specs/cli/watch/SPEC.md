---
id: cli/watch
title: "Watch CLI"
kind: capability
domain: cli
capability: watch
status: draft
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli/commands/watch.ts
  - src/watch
  - src/triggers
tags:
  - cli
  - watch
  - triggers
---

# Watch CLI

## Intent

`ravi watch` is the human and agent CLI for creating watches, inspecting
connector capabilities, and wiring watch events to triggers.

`ravi watch` MUST be top-level. It MUST NOT live under `ravi inbox`.

## Commands

The CLI SHOULD support:

```bash
ravi watch connectors
ravi watch create npm <package> [--event <event-type>] [--placement auto|local|console]
ravi watch create github <owner/repo> [--event <event-type>] [--placement auto|local|console]
ravi watch list
ravi watch show <watch-id>
ravi watch enable <watch-id>
ravi watch disable <watch-id>
ravi watch rm <watch-id>
ravi watch run <watch-id> --once
ravi watch events <watch-id>
ravi watch trigger <watch-id> --message <prompt> [--event <event-type>]
```

Commands consumed by agents MUST support `--json`.

## Create Semantics

`create` MUST:

1. resolve the connector;
2. validate connector config;
3. choose placement from explicit flag or `auto`;
4. create a durable watch record;
5. show event subjects that triggers can subscribe to;
6. show the next command to create a trigger.

If the chosen placement is `console`, the CLI MUST use cloud-auth and Console
watch APIs. If credentials or scope are missing, it MUST fail clearly without
creating a partial local watch.

If the chosen placement is `local`, the CLI MUST create local watch state that
the local daemon can run.

## Console Placement

For Console-hosted watches, the CLI MUST use the public endpoint contract in
`watch/console-provider`.

`--placement auto` SHOULD:

1. call `GET /api/cli/watches/capabilities`;
2. choose `console` when the provider recommends Console and all required
   installation/repository/permission/inbox checks pass;
3. fail before `POST /api/cli/watches` when capabilities returns requested
   `unsupportedEventTypes`;
4. fail with an actionable Console error when required setup is missing;
5. avoid silently falling back to local polling for webhook-backed providers.

For GitHub, `console` placement means the Ravi GitHub App handles webhooks in
Console. The local CLI creates a provider watch and receives events through
inbox.

## Trigger Helper

`ravi watch trigger` MUST create a normal `ravi triggers` record. It is a
convenience helper, not a separate trigger engine.

When invoked from a chat context, it SHOULD capture that chat as the trigger
reply source so future events can notify the same group.

The helper SHOULD derive:

- topic from watch connector and event type;
- filter from `watchId`;
- default name from watch name and event type.

## Output

Human output SHOULD include:

- watch id and name;
- connector and placement;
- watched source;
- event subjects;
- trigger helper command;
- disable command.

JSON output MUST include equivalent fields without secrets.

## Error Handling

The CLI SHOULD pass through stable Console watch error codes:

- `AUTH_REQUIRED`
- `WATCH_CAPABILITY_UNAVAILABLE`
- `INSTALLATION_MISSING`
- `REPO_NOT_SELECTED`
- `PROVIDER_PERMISSION_MISSING`
- `PROVIDER_CONNECTION_UNAVAILABLE`
- `PROVIDER_RESOURCE_UNAVAILABLE`
- `WATCH_UNSUPPORTED_EVENT`
- `WATCH_ALREADY_EXISTS`
- `WEBHOOK_UNHEALTHY`
- `INBOX_SUBSCRIPTION_MISSING`
- `LOCAL_INSTALLATION_REVOKED`
- `RATE_LIMITED`

When Console returns `installUrl` or `connectUrl`, human output SHOULD show the
next action instead of falling back to an inferior placement.

## Auth Scopes

Remote watch management SHOULD require:

- `console.watches.read`
- `console.watches.write`

These are separate from inbox delivery scopes. A CLI can be allowed to create
remote watches without changing the inbox polling contract, and inbox can be
allowed to deliver events without granting watch management.

## Acceptance Criteria

- `ravi watch connectors --json` exposes npm and GitHub connector metadata.
- `ravi watch create npm ...` and `ravi watch create github ...` produce durable
  watch records and trigger-ready subjects.
- `ravi watch trigger ...` creates an ordinary trigger that replies to the
  current chat when invoked from a chat.
- `ravi inbox` remains only a Console watch event delivery surface.
- `ravi watch create github ... --placement auto` uses Console/GitHub App when
  available and errors actionably when install/repo/permission/inbox setup is
  missing.
