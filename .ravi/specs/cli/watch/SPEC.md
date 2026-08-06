---
id: cli/watch
title: "Watch CLI"
kind: capability
domain: cli
capability: watch
status: active
normative: true
owners:
  - ravi-dev
applies_to:
  - src/cli/commands/watch.ts
  - src/cli/commands/watch.test.ts
  - src/cli/agent-contract.ts
  - src/watch
  - src/triggers
tags:
  - cli
  - watch
  - triggers
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
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
ravi watch rm <watch-id> [--execute]
ravi watch run <watch-id> --once [--execute]
ravi watch events <watch-id>
ravi watch trigger <watch-id> --message <prompt> [--event <event-type>] [--execute]
```

Commands consumed by agents MUST support `--json`. `rm`, `trigger` and `run`
are braked: without `--execute` they are dry-runs (exit 3) — see the
agent-first contract below.

## Agent-First Contract (Manual v2)

`ravi watch` follows the agent-first contract defined by `cli/crm` (typed error
envelopes, 0/1/2/3 exit taxonomy, write brake, compact discovery), implemented
at the source with the shared helpers in `src/cli/agent-contract.ts`.

### Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?|acceptedFlags?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. `show`, `events`, `enable`, `disable`, `rm`, `trigger` and `run` on an
   unknown id MUST exit 1 with `WATCH_NOT_FOUND` and up to 3 `suggestions`
   built from live watch ids/names/resources.
4. `rm`, `trigger` and `run` MUST default to dry-run and require `--execute`;
   the dry-run MUST report `dryRun: true` and the `plan`, and MUST NOT delete
   the watch, create the trigger, or start a poll cycle. `trigger`'s plan MUST
   show the resolved watch and the exact trigger record that would be created.
5. Validation happens BEFORE the brake: missing `--message`, unknown watch,
   unknown `--agent` and non-local placement (for `run`) fail without emitting
   a dry-run plan.
6. `watch list` MUST accept `--fields a,b,c` for compact output.
7. In agent context (`RAVI_*` envs present) a thrown `ContractError` MUST
   preserve its exit code through the registry dispatcher, and the
   `runWatchCommand` wrapper MUST rethrow `ContractError` instead of remapping
   it to `WATCH_COMMAND_FAILED`.
8. Unbraked writes (`create`, `enable`, `disable`) keep their current
   immediate-write behavior (declared): `create` is the domain's entry point
   with an obvious inverse (`rm`), and `enable`/`disable` are a reversible
   pair.

### Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| rm | destructive (local + remote console deletion) | dry-run + `--execute` |
| trigger | arms a real automation (future events fire agent prompts) | dry-run + `--execute` |
| run | fires a real poll cycle that can emit events / fire triggers | dry-run + `--execute` |
| create | reversible entry point (`rm` undoes it) | not braked (declared) |
| enable / disable | reversible pair | not braked (declared) |

### Official error cases

| case | code | exit |
|---|---|---|
| watch not found | `WATCH_NOT_FOUND` + suggestions | 1 |
| invalid flag/arg | `USAGE_ERROR` + acceptedFlags | 2 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| provider/console failure | stable console codes (see Error Handling) | 1 |

### Known gap

There is no shipped `watch` skill teaching this surface; the CLI's own
`create` output and this spec are the only internal consumers that teach
`watch trigger`, and both carry `--execute`. Registered as a gap for a future
wave.

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
Console delivery.

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
- `DELIVERY_SUBSCRIPTION_MISSING`
- `INBOX_SUBSCRIPTION_MISSING` as a legacy compatibility alias
- `LOCAL_INSTALLATION_REVOKED`
- `RATE_LIMITED`

When Console returns `installUrl` or `connectUrl`, human output SHOULD show the
next action instead of falling back to an inferior placement.

## Auth Scopes

Remote watch management SHOULD require:

- `console.watches.read`
- `console.watches.write`

These are separate from Console delivery scopes. A CLI can be allowed to create
remote watches without changing the delivery polling contract, and delivery can
be allowed to deliver events without granting watch management.

## Acceptance Criteria

- `ravi watch connectors --json` exposes npm and GitHub connector metadata.
- `ravi watch create npm ...` and `ravi watch create github ...` produce durable
  watch records and trigger-ready subjects.
- `ravi watch trigger ... --execute` creates an ordinary trigger that replies to
  the current chat when invoked from a chat; without `--execute` it exits 3
  with the resolved plan and creates nothing.
- `ravi watch rm <id>` and `ravi watch run <id> --once` without `--execute`
  exit 3 and change nothing.
- Unknown watch ids return `WATCH_NOT_FOUND` (exit 1) with live suggestions;
  `watch list --fields a,b,c` narrows items.
- Console-hosted watch events are delivered through Console delivery.
- `ravi inbox` is reserved for the local real inbox; any current Console
  delivery use of `ravi inbox` is a compatibility alias only.
- `ravi watch create github ... --placement auto` uses Console/GitHub App when
  available and errors actionably when install/repo/permission/inbox setup is
  missing.
