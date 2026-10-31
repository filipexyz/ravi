# Diagnosis and evidence

Baseline: `caf65661` (origin/dev at worktree creation). This investigation used
source and isolated fixtures only, never the production database. The table
below is static reachability evidence, not a claim that every endpoint was
invoked on production.

## Original error path (baseline line numbers)

| Stage | Evidence |
| --- | --- |
| Handler rejects absent instructions | `src/cli/commands/tasks.ts:1134`: `fail("--instructions is required")` |
| Handler error is typed too broadly | `src/cli/context.ts:220`: `fail()` throws `CliExpectedError(message, "COMMAND_FAILED", 1)` inside daemon context |
| Expected message survives gateway mapping | `src/cli/agent-contract.ts:107`: `expectedErrorToContractError()` sanitizes expected public copy and preserves COMMAND_FAILED |
| Gateway catches handler exception | `src/sdk/gateway/dispatcher.ts:201`: catch maps error then calls `contractErrorResponse` at line 248 |
| HTTP status becomes 422 | `src/sdk/gateway/errors.ts:74`: execution failures default to 422; no correlation id |
| Remote CLI discards the safe message | `src/cli/remote-gateway.ts:907`: `remoteContractFailureMessage()` ends at line 940 returning `REMOTE_GENERIC_FAILURE`; its literal is at line 679 |
| Remote CLI discards the next action | `src/cli/remote-gateway.ts:965`: default action at line 972 is “Inspect redacted remote logs…” |
| Only some internal exceptions get stack logging | `src/sdk/gateway/dispatcher.ts:226`: only UNHANDLED_ERROR inside the handler catch logs a stack (line 242); no requestId, no cause chain, no rate limit |
| Outer gateway boundary has no catch | `src/sdk/gateway/server.ts:113`: awaits processing directly; auth/body plumbing and post-handler serialization can escape |
| Access log cannot explain the failure | `src/sdk/gateway/server.ts:263`: method/path/status/duration, no correlation to a diagnostic |

The previous SQLite fix already logs a subset of handler errors. It did not
repair the remote CLI projection or the uncaught portions of the request path.

## Exposed required-field sites

The scan matched literal `fail("--flag is required[.]")` call sites, associated
them with their decorated group and command, then intersected them with the
actual `buildRouteTable(buildRegistry(...commands))` paths. It found **45 sites
in 28 exposed endpoints**. Four additional command paths were excluded because
they are CLI-only: sandbox/run, credentials/connections/add,
credentials/connections/remove and credentials/broker/exec. Shared helper
failures and other validation phrasings extend the affected class beyond this
lower-bound inventory.

The baseline remote projection was also executed in an isolated fixture with
the corresponding public missing-field envelopes: all 45 cases (28 paths)
returned the generic message and log-inspection action, with 90 assertions.

All entries below reached the same uncatalogued remote COMMAND_FAILED fallback
on the baseline (subject to the command's prior permission/lookup gates).
The common expected-error mapper and remote projection fix them together;
individual handlers are unchanged. Watch's wrapper can assign its own error
code; its safe public explanation now survives too.

| Endpoint | Missing flag | Source evidence |
| --- | --- | --- |
| `POST /api/v1/runtime/credentials/import` | `--provider` | `src/cli/commands/runtime-credentials.ts:361` |
| `POST /api/v1/runtime/credentials/import` | `--label` | `src/cli/commands/runtime-credentials.ts:362` |
| `POST /api/v1/runtime/credentials/select` | `--provider` | `src/cli/commands/runtime-credentials.ts:530` |
| `POST /api/v1/runtime/credentials/classify` | `--provider` | `src/cli/commands/runtime-credentials.ts:566` |
| `POST /api/v1/watch/trigger` | `--message` | `src/cli/commands/watch.ts:342` |
| `POST /api/v1/artifacts/restore` | `--version` | `src/cli/commands/artifacts.ts:903` |
| `POST /api/v1/artifacts/restore` | `--version` | `src/cli/commands/artifacts.ts:905` |
| `POST /api/v1/workflows/runs/task-create` | `--title` | `src/cli/commands/workflows.ts:611` |
| `POST /api/v1/workflows/runs/task-create` | `--instructions` | `src/cli/commands/workflows.ts:614` |
| `POST /api/v1/threads/create` | `--title` | `src/cli/commands/threads.ts:175` |
| `POST /api/v1/runtime/presets/create` | `--provider` | `src/cli/commands/runtime-presets.ts:199` |
| `POST /api/v1/runtime/presets/create` | `--model` | `src/cli/commands/runtime-presets.ts:200` |
| `POST /api/v1/crm/pipeline/stage/add` | `--name` | `src/cli/commands/crm.ts:1763` |
| `POST /api/v1/crm/pipeline/stage/add` | `--order` | `src/cli/commands/crm.ts:1764` |
| `POST /api/v1/crm/pipeline/stage/topic/add` | `--title` | `src/cli/commands/crm.ts:1918` |
| `POST /api/v1/cron/add` | `--message` | `src/cli/commands/cron.ts:654` |
| `POST /api/v1/tasks/profiles/preview` | `--title` | `src/cli/commands/tasks-profiles.ts:208` |
| `POST /api/v1/sessions/followups/snooze` | `--until` | `src/cli/commands/session-followups.ts:562` |
| `POST /api/v1/credentials/connections/show` | `--provider` | `src/cli/commands/credentials.ts:231` |
| `POST /api/v1/credentials/connections/show` | `--connection` | `src/cli/commands/credentials.ts:232` |
| `POST /api/v1/credentials/connections/disable` | `--provider` | `src/cli/commands/credentials.ts:391` |
| `POST /api/v1/credentials/connections/disable` | `--connection` | `src/cli/commands/credentials.ts:392` |
| `POST /api/v1/credentials/policies/explain` | `--provider` | `src/cli/commands/credentials.ts:421` |
| `POST /api/v1/credentials/policies/explain` | `--connection` | `src/cli/commands/credentials.ts:422` |
| `POST /api/v1/credentials/policies/explain` | `--action` | `src/cli/commands/credentials.ts:423` |
| `POST /api/v1/prox/calls/request` | `--profile` | `src/cli/commands/prox-calls.ts:674` |
| `POST /api/v1/prox/calls/request` | `--person` | `src/cli/commands/prox-calls.ts:675` |
| `POST /api/v1/prox/calls/request` | `--reason` | `src/cli/commands/prox-calls.ts:676` |
| `POST /api/v1/prox/calls/voice-agents/create` | `--name` | `src/cli/commands/prox-calls.ts:1200` |
| `POST /api/v1/prox/calls/voice-agents/create` | `--provider` | `src/cli/commands/prox-calls.ts:1201` |
| `POST /api/v1/prox/calls/tools/create` | `--name` | `src/cli/commands/prox-calls.ts:1554` |
| `POST /api/v1/prox/calls/tools/create` | `--description` | `src/cli/commands/prox-calls.ts:1555` |
| `POST /api/v1/prox/calls/tools/create` | `--executor` | `src/cli/commands/prox-calls.ts:1556` |
| `POST /api/v1/prox/calls/tools/create` | `--side-effect` | `src/cli/commands/prox-calls.ts:1557` |
| `POST /api/v1/prox/calls/tools/run` | `--input` | `src/cli/commands/prox-calls.ts:1767` |
| `POST /api/v1/triggers/add` | `--topic` | `src/cli/commands/triggers.ts:564` |
| `POST /api/v1/contacts/link` | `--channel` | `src/cli/commands/contacts.ts:1745` |
| `POST /api/v1/contacts/link` | `--id` | `src/cli/commands/contacts.ts:1746` |
| `POST /api/v1/tasks/create` | `--instructions` | `src/cli/commands/tasks.ts:1134` |
| `POST /api/v1/tasks/archive` | `--reason` | `src/cli/commands/tasks.ts:1833` |
| `POST /api/v1/tasks/dispatch` | `--agent` | `src/cli/commands/tasks.ts:1917` |
| `POST /api/v1/tasks/automations/add` | `--title` | `src/cli/commands/tasks-automations.ts:322` |
| `POST /api/v1/tasks/automations/add` | `--instructions` | `src/cli/commands/tasks-automations.ts:325` |
| `POST /api/v1/sessions/attach` | `--chat` | `src/cli/commands/sessions.ts:6306` |
| `POST /api/v1/sessions/detach` | `--chat` | `src/cli/commands/sessions.ts:6395` |

## Current operation

1. Read `error.code`, `error.message` and `error.issues`. For validation, correct
   the named field; do not retry the same input.
2. For internal errors, use `error.requestId` (also `x-request-id`) to find the
   `Gateway command exception` log. Repeated failures include
   `error.diagnosticRequestId`: use that first logged request for the stack.
3. Diagnostic records carry the operation, stable code, up to eight stack
   frames and four nested causes. Same-signature repeats are suppressed for
   60 seconds; the next emitted record includes `suppressed`. This is an
   in-memory, per-process, bounded cache; a restart begins a new window.
4. Do not enable raw request/provider payload logging. The diagnostic record
   excludes inputs, authorization, arbitrary error properties and headers.
5. Fix the underlying failure before retrying a write; a 500 may follow a
   successful mutation whose response could not be serialized.

Scope: this contract covers the SDK gateway `/api/v1` boundary, including
stream admission errors. Events after an SSE response has already started are
stream events, not new HTTP 4xx/5xx responses. Other daemon webhook routes are
outside this change.
