# Error cause masking audit

Baseline: `origin/dev` at `7b86f626`. Line numbers below refer to that baseline.
Console bug (high): https://console.ravi.bot/bugs/b1ab0925-822e-474a-8152-5d839ee66032

## Findings

| Boundary | Source | Masked result / information lost | Initial fix |
| --- | --- | --- | --- |
| Transcribe tool | `src/cli/commands/transcribe.ts:73-80` | `Audio transcription failed.` replaces the entire exception; no provider/status/file | Yes |
| Missing audio | `src/cli/commands/transcribe.ts:58` | `Audio file was not found.` removes the input path | Yes |
| Media send | `src/cli/commands/media.ts:150-157`, `src/cli/media-send-auth.ts:116-130` | `Media delivery failed.`; only Omni authentication gets classification | Follow-up |
| Shared unexpected tool/CLI error | `src/cli/agent-contract.ts:128-169` | Mapper receives only operation; original error is lost | Yes |
| Shared expected error | `src/cli/agent-contract.ts:264-271` | A token assignment or provider sentinel causes the whole message to disappear | Yes |
| Public/audit value projection | `src/cli/redaction.ts:150-152` | Any `reason`, `message`, `output` becomes `[REDACTED:content]` | Separate diagnostic projection; audit/plan stays minimized |
| Gateway permission | `src/sdk/gateway/errors.ts:84-100,127-128` | `permissionDenied` supplies `reason`, projection accepts only `message` | Yes |
| Remote permission | `src/cli/remote-gateway.ts:411-417,967` | `Remote gateway denied the command.` loses the actor, action and source reason; typed capability/stage/id sometimes survive | Yes |
| Remote diagnostic details | `src/cli/remote-gateway.ts:1098-1178` | `cause` and provider/file context are not projected | Yes |
| Remote Bash hook | `src/cli/codex-hook-transport.ts:29-44,76-80` | Fixed possible causes / `unable to evaluate the hook` replace known reason | Yes |
| Bridge hook | `src/cli/commands/context.ts:694-695` | Empty catch: `Bridge command authority is unavailable` | Yes |
| CLI text | `src/cli/agent-contract.ts:224-246` | Returns after headline when there are no validation issues | Yes |
| Runtime public failure | `src/runtime/public-failure.ts:83-130` | Internal runtime error / temporarily unavailable; EACCES, SQLite, quota, billing, native diagnostics discarded | Follow-up |
| Operator/observer state | `src/runtime/host-event-loop.ts:4330,4386`, `src/runtime/session-launcher.ts:498` | Reuses the same public-failure masking for operator state | Follow-up |
| Waited session CLI | `src/cli/commands/sessions.ts:2067,6209` | Calling agent receives the masked runtime message | Follow-up |
| Channel error schema | `src/channels/backend.ts:45-62`, `src/channels/runtime-events.ts:846-855` | Carries class/correlation, no cause/context; explicitly host-only provider text | Follow-up |
| Slack renderer | `src/channels/slack/driver.ts:189-209` | `The agent is not allowed to do that.` or generic internal error | Follow-up |
| Slack inbound audio | `src/channels/slack/socket-mode.ts:2328,3145,3159-3171` | Error retained in metadata but prompt says only `Transcript: unavailable` | Follow-up |
| Omni inbound audio/media | `src/omni/consumer.ts:2725-2744,2773-2789` | Catch logs then drops cause; prompt shows only Audio/file | Follow-up |

## Historical evidence

The security-removal hypothesis is confirmed, with a narrower conclusion than
"every masking site was a security fix":

- `71ba610885f076cc7aa347bb4709513eabbed5e8`, 2026-08-08,
  `fix: redact media provider failures`: replaced `err.message` / `String(err)`
  with empty catches and fixed transcription/media headlines. Tests required
  arbitrary provider strings to disappear, without recognizing a credential.
- `13f90039afac2588565fb82a4a7e154c609e6ff1`, `fix: sanitize agent contract
  outputs`: introduced broad content suppression at shared boundaries.
- `3947d415450f46e28b2a115fda710d9828f5d439`, `fix: canonicalize remote
  contract failures`: replaced remote `body.reason` with a fixed denial.
- `f75205a419394ec171bf05c0b74cf1dcf7cc4a1a`, `fix(cli): normalize unexpected
  transport failures`: fallback loses the original exception and codifies
  generic responses in the spec.
- `ddb51045bda625d7918cc9040b0b7c5f237a907e` and
  `482c90f01914d83a95b44e893a48ddf32d6dc84f` improved expected-error guidance
  but retained whole-message rejection for credentials/secret assignments.
- `387138fb400ee747df1a60d2e63f2356142cde8f` recovered typed denial metadata,
  but not the original text.
- `5e7be5f99681506e647f9f576a61b005610478be`, 2026-07-21, created runtime
  masking and a rule treating local paths, exception details and credential
  values together. The same pattern list contains EACCES and bearer tokens.
- `8ff5c4aefe05c91711f2b10945b8e9ed02387841` explicitly hid SQLite errors;
  `b37985a237db57f0d0a4fbe5f9a8b70f4d887804` hid credential/account/quota
  failures; `07e670cbb81e71f4c1e94c946064f27557af5011` kept channel provider
  text host-only; `780ad9ec9101f44c55466cb8be90b0de3e0d3963` hid native
  diagnostics; `1c69448a` mapped transport failures to unavailable.
- Slack inbound omission existed from `d713d296`; Omni catch/log/drop from
  `b663a287` (file retention added in `60e5b4037`). No evidence these two
  formatters later removed detail for security.

Some protections were concrete: credential values and ANSI/bidi control text.
Neither an EACCES cause nor an arbitrary provider error is itself a credential.
No inspected commit establishes a need to remove the entire failure reason.

## Local reproductions

Run against the baseline, using real handlers/projections with synthetic
failures. No provider request, production state or real credentials used:

1. `TranscribeCommands.file` with an existing fixture file and mocked
   transcription service throwing `Error("HTTP 429: audio quota exceeded for
   model whisper-1")`, `status=429`, `provider=openai`. Final JSON contains only
   `TRANSCRIBE_FAILED`, `Audio transcription failed.`, retry and key guidance.
2. `remoteGatewayErrorToContractError` with HTTP 403 and a coherent
   `PERMISSION_DENIED` envelope whose message identifies `agent:fixture`,
   provider policy and `read context:codex-bash-hook`. Output replaces it with
   `Remote gateway denied the command.`
3. `formatUserFacingTurnFailure("EACCES: permission denied, open
   /tmp/report.wav")` returns the generic internal runtime error.
4. `publicContractMessage("COMMAND_FAILED", "HTTP 429: quota exhausted;
   token=fixture-only")` returns `Command could not be completed.` rather than
   preserving the cause with `token=[redacted]`.

The submitted dossier contains the actual baseline outputs. Regression fixtures
now live in `src/cli/commands/transcribe.test.ts`,
`src/transcribe/error-context.test.ts`, `src/utils/error-diagnostic.test.ts`,
`src/cli/transport-contract.test.ts`, `src/cli/remote-gateway.test.ts`,
`src/cli/commands/context-hook-gateway.test.ts`, and gateway error tests.

## Contract and scope

A failure carries `code` (class), `message` (what failed), `cause` (original
provider/OS reason and nested causes), and an explicit `context` projection
(operation/provider/model/status/file/code/syscall when known). Replace secret
values with `[redacted]` while retaining the field. Do not serialize arbitrary
request bodies, response payloads, headers or stacks. Audit and dry-run plans
retain their separate minimization rules. Permission decisions do not change.

This first correction covers tool/CLI/gateway/hook delivery. It does not claim
that runtime-to-chat or inbound audio masking is already fixed. Those sites
remain in this same bug inventory for the next implementation slice.
