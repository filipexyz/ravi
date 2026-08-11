---
id: cli/artifacts
title: "Artifacts agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - artifacts
tags:
  - cli
  - artifacts
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
applies_to:
  - src/cli/commands/artifacts.ts
  - src/cli/agent-contract.ts
  - src/artifacts/store.ts
  - src/artifacts/publish-client.ts
  - src/plugins/internal/ravi-system/skills/artifacts/SKILL.md
owners:
  - ravi-dev
status: active
normative: true
---
# Artifacts agent-first CLI contract

## Intent

Make `ravi artifacts` (and the `artifacts.release` group) reliable for agent
consumers under the agent-first contract defined by `cli`: typed error
envelopes, the 0/1/2/3 exit taxonomy, a write brake on the ops that expose
content externally, and compact discovery. The local ledger writes stay
immediate — the brake sits exactly where bytes leave the machine: `publish`
(upload + Pages release) and `release activate` (flips live hosted content).

## Invariants

1. With `--json`, every failure on a migrated op MUST return the envelope
   `{success:false, op, error:{code, message, retryable, suggestedAction, suggestions?}}`.
2. Exit codes MUST follow the taxonomy: `0` success · `1` error (not-found /
   provider) · `2` usage error · `3` blocked by policy (write brake).
3. Every id-taking op (`show`, `snapshot`, `versions`, `version`, `restore`,
   `update`, `attach`, `archive`, `event`, `events`) on an unknown artifact
   MUST exit 1 with `ARTIFACT_NOT_FOUND` and up to 3 `suggestions` from the
   local ledger (ids/titles) — even though the store throws on unknown ids
   instead of returning null (`withArtifactContract` maps the throw).
4. `version` and `restore` on an unknown version of a known artifact MUST exit
   1 with `ARTIFACT_VERSION_NOT_FOUND` and a suggestedAction pointing at
   `ravi artifacts versions <id> --json` (no similarity suggestions — version
   numbers are dense integers).
5. `publish` and `release activate` MUST default to dry-run and require
   `--execute`; the dry-run MUST report `dryRun: true` and the `plan`, and MUST
   NOT open an upload session or call Console at all. `--execute` is the LAST
   declared option on both ops. The publish plan keeps the target kind and
   artifact id (when applicable), project/site/visibility/slug/version and the
   activation booleans; route, published name and entrypoint are represented
   only by `routePresent`, `namePresent` and `entrypointPresent`.
6. `artifacts list` MUST accept `--fields a,b,c` for compact output on the
   standard listing (`--rich` keeps its own fixed projection).
7. A thrown `ContractError` MUST pass through the legacy CloudAuthError funnel
   of `publish`/`release activate` and the legacy try/catch of `events`
   untouched (rethrow-first, model: mail.ts / agents.ts).
8. `blob` is `@Returns.binary`: successful bytes stay unchanged, while a
   non-success `Response` is normalized to the shared redacted error envelope
   across CLI, tool and gateway.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| publish | uploads bytes to Console + (default) activates a hosted Pages release (external exposure, high) | dry-run + `--execute` |
| release activate | flips which content is live on the hosted site (external exposure, high) | dry-run + `--execute` |
| create / update / attach / event / snapshot | local ledger writes, reversible/append-only | not braked (declared) |
| archive / restore | reversible pair: archive is a soft-delete (listable with `--include-deleted`); restore recovers content from an immutable version and records a new version | not braked (declared) |

## Official error cases

| case | code | exit |
|---|---|---|
| artifact not found | `ARTIFACT_NOT_FOUND` + suggestions (local ids/titles) | 1 |
| artifact version not found | `ARTIFACT_VERSION_NOT_FOUND` + versions listing suggestedAction | 1 |
| braked write without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| Console auth/provider failure on publish/activate | stable CloudAuthError code | `2` for `PAYLOAD_INVALID`; otherwise `1` |

## Internal consumers

`src/plugins/internal/ravi-system/skills/artifacts/SKILL.md` teaches this
surface and MUST document `--execute` on every braked op and list the unbraked
writes explicitly. `README.md` teaches `ravi artifacts publish` and carries
`--execute`. `src/sdk/gateway/artifacts-show.integration.test.ts` exercises
`artifacts show` through the gateway registry and stays green — the not-found
path there is not exercised with unknown ids.

## Parser contract

Parser-level usage errors (unknown flag / missing argument) use the exit-2
`USAGE_ERROR` envelope with `acceptedFlags`.

## Validation

- `bun test src/cli/commands/artifacts.test.ts` green (contract suite created
  in this wave), no new failures vs the `dev` baseline.
- `bun test src/sdk/gateway/artifacts-show.integration.test.ts` green.
- Live checks on the local CLI (isolated `RAVI_STATE_DIR`):
  `artifacts show art-nope --json` → `ARTIFACT_NOT_FOUND`, exit 1;
  `artifacts publish ./site --project p --site s --json` → exit 3, no upload;
  same command with `--execute` → publishes; `artifacts list --json --fields
  id,kind` narrows items; `artifacts archive <id>` still writes immediately.

## Known Failure Modes

- The artifact store throws `Artifact not found: <id>` (and `Artifact version
  not found: <id> vN`) instead of returning null; mapping only the null path of
  `getArtifactDetails` misses every other op and regresses to plain text +
  exit 1 (`withArtifactContract` covers the throw).
- The `publish`/`release activate` catch blocks funnel everything through
  `cloudAuthErrorFromUnknown` and `process.exit`; without the ContractError
  rethrow, a braked dry-run in agent context would be flattened to
  `SERVER_UNAVAILABLE` + exit 5 — silently defeating the brake taxonomy.
- `artifacts.test.ts` mocks `../context.js`; the mock MUST export `hasContext`
  or the contract helpers crash in tests (same trap as tasks.test.ts).
