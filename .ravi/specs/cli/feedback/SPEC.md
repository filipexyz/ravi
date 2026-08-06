---
id: cli/feedback
title: "Feedback agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - feedback
tags:
  - cli
  - feedback
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/feedback.ts
  - src/cli/agent-contract.ts
  - src/feedback/client.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Feedback agent-first CLI contract

## Intent

Make `ravi feedback` reliable for agent consumers under the agent-first
contract defined by `cli`. The domain has a single op, `send` (alias
`create`), and it publishes OUTSIDE the local runtime — a POST to the Ravi
Console (`/api/cli/feedback`) visible to the whole organization. External,
non-retractable publication is exactly the class the write brake exists for,
so `send` is braked.

## Invariants

1. `feedback send` MUST default to dry-run and require `--execute`; the
   dry-run MUST report `dryRun: true` and a `plan` mirroring the normalized
   payload that would be submitted (kind, severity, title, message, surface,
   project, url, tags, metadata, console), and MUST NOT read credentials nor
   perform any network call.
2. The brake MUST fire BEFORE authentication: a dry-run works without stored
   credentials and leaks nothing off the machine.
3. Payload validation MUST fail fast even in dry-run: invalid `--kind`,
   `--severity`, `--metadata-json` or an empty message exit with the existing
   `PAYLOAD_INVALID` CloudAuthError (exit 1), never exit 3.
4. A thrown `ContractError` (the brake) MUST NOT be wrapped by the
   CloudAuthError mapper — it bubbles to the dispatcher preserving exit 3.
5. Existing cloud error semantics stay: `AUTH_REQUIRED`/`AUTH_EXPIRED` teach
   `ravi login`; with `--json` cloud errors keep the `formatCloudAuthError`
   shape.
6. There is no entity lookup in this domain, so no `*_NOT_FOUND` envelope
   applies — declared. There is also no listing, so no `--fields` surface.
7. When invoked from an agent context (`RAVI_*` envs present), the brake MUST
   preserve exit 3 through the registry dispatcher.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| send (alias create) | publishes externally to Ravi Console; not retractable via CLI | dry-run + `--execute` |

## Official error cases

| case | code | exit |
|---|---|---|
| braked send without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid payload (kind/severity/metadata/message) | `PAYLOAD_INVALID` | 1 |
| missing/expired credentials | `AUTH_REQUIRED` / `AUTH_EXPIRED` | 1 |

## Internal consumers

No repo doc or shipped skill teaches `ravi feedback send` today (gap
registered by the CLI migration): the domain has no SKILL.md. When one is
created it MUST carry `--execute` on every send example and teach the dry-run
plan as the review step.

## Validation

- `bun test src/cli/commands/feedback.test.ts` green (contract block
  included).
- Live checks: `ravi feedback send "test" --json` → exit 3 + plan, no network;
  `ravi feedback send "test" --execute --json` → submits (requires login);
  `--kind bogus` → `PAYLOAD_INVALID` exit 1 even without `--execute`.

## Known Failure Modes

- `runFeedbackCommand` wraps unknown errors as `SERVER_UNAVAILABLE`; without
  the explicit `ContractError` rethrow the brake would be swallowed into a
  cloud-error envelope with the wrong exit code.
- The dry-run plan must be built from the NORMALIZED values (via
  `normalizeFeedbackKind/Severity/Tags`) or the plan lies about what
  `--execute` would submit.
