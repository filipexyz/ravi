# Command failure control audit

Snapshot: `59381599`. Audit of all non-test `.ts` files beneath `src/cli/commands`. The follow-up restores the declared controls using explicit bounded projections; paths remain markers and free-form provider payloads remain excluded.

- Files scanned: **110**.
- Direct `contractFail` / `new ContractError` sites: **265**.
- Distinct statically observed top-level detail keys: **49**.
- Keys admitted at that head: **42**; missing: **7**.
- Sites with imported/wrapper/dynamic detail sources: **11**, followed in the wrapper audit below.
- AST expands direct object literals, local variable initializers, object spreads and conditional object alternatives. It does not claim interprocedural proof or validate the contents of admitted nested controls. No aliased imports of the constructor/helper were found in these command sources.

## Missing direct controls

| Key | Producer | Shape / decision |
| --- | --- | --- |
| `drift` | sdk.ts:259,383,507,631 | OpenAPI boolean; SDK list of `{file,path,reason}`. Retain bounded list with typed/redacted fields. |
| `liveBytes`, `storedBytes` | sdk.ts:259 | Nonnegative finite integer byte counters. |
| `allowedKeys` | runtime-env.ts:96 | Names from fixed environment-key allowlist; no values. |
| `reason` | daemon.ts:1222 | Exact classification `admin_context_exists`; do not open arbitrary free-form provider reason properties. |
| `path`, `dir` | sdk.ts:259,383,507,631 | Absolute filesystem inputs; preserve markers only if preserving these control keys. Do not admit raw paths. |

The SDK missing-file `drift.reason` embeds the same absolute `drift.path` in the OS error text. Redact that known path while normalizing the reason; removing only the separate path property would reintroduce a privacy leak.

`contrast` is emitted by the imported Library diagnostic wrapper rather than a direct command literal; covered by the wrapper audit and the requested root fix.

## Every directly observed key (representative producer locations)

| Field | Baseline projection | Producer call locations |
| --- | --- | --- |
| `acceptedFlags` | admitted | `audio.ts:162`, `crm.ts:2239`, `daemon.ts:772` (+3 other callsites) |
| `acceptedPositionals` | admitted | `audio.ts:162`, `connectors.ts:338`, `connectors.ts:354` |
| `acceptedValues` | admitted | `image.ts:55`, `insights.ts:51`, `metrics.ts:125` (+3 other callsites) |
| `allowedKeys` | missing | `runtime-env.ts:96` |
| `basesUses` | admitted | `pages.ts:2681` |
| `cause` | admitted | `agenda.ts:480`, `agenda.ts:495`, `bases.ts:3064` (+3 other callsites) |
| `consoleError` | admitted | `bases.ts:3064` |
| `context` | admitted | `agenda.ts:480`, `agenda.ts:495`, `bases.ts:3064` (+3 other callsites) |
| `current` | admitted | `bases.ts:3064` |
| `currentChat` | admitted | `permissions.ts:1170` |
| `denialId` | admitted | `cron.ts:226`, `triggers.ts:116` |
| `dir` | missing | `sdk.ts:383`, `sdk.ts:507`, `sdk.ts:631` |
| `drift` | missing | `sdk.ts:259`, `sdk.ts:383`, `sdk.ts:507` (+1 other callsites) |
| `effectState` | admitted | `session-conversations.ts:62` |
| `errors` | admitted | `crm.ts:1298`, `observers.ts:1016`, `observers.ts:824` (+1 other callsites) |
| `existing` | admitted | `daemon.ts:1222` |
| `files` | admitted | `sdk.ts:383`, `sdk.ts:507`, `sdk.ts:631` (+1 other callsites) |
| `gaps` | admitted | `crm.ts:1210` |
| `highSeverityGaps` | admitted | `crm.ts:1210` |
| `importProgress` | admitted | `bases.ts:3064` |
| `inputsHash` | admitted | `bases.ts:3064` |
| `issues` | admitted | `artifacts.ts:292`, `artifacts.ts:306`, `bases.ts:3064` (+19 other callsites) |
| `liveBytes` | missing | `sdk.ts:259` |
| `mediaPathPresent` | admitted | `stickers.ts:443` |
| `missingScopes` | admitted | `bases.ts:3064` |
| `operation` | admitted | `sessions-runtime.ts:121`, `sessions-runtime.ts:184`, `sessions-runtime.ts:199` |
| `options` | admitted | `meetings.ts:985` |
| `override` | admitted | `pages.ts:2681` |
| `ownerPrincipal` | admitted | `cron.ts:312` |
| `path` | missing | `sdk.ts:259` |
| `pipelineId` | admitted | `crm.ts:1210`, `crm.ts:1298` |
| `reason` | missing | `daemon.ts:1222` |
| `refusal` | admitted | `agenda.ts:441`, `meetings.ts:1628` |
| `requestId` | admitted | `bases.ts:3064` |
| `requiredCapability` | admitted | `cron.ts:226`, `cron.ts:262`, `triggers.ts:116` (+1 other callsites) |
| `retryable` | admitted | `connectors.ts:141`, `connectors.ts:154`, `connectors.ts:166` (+16 other callsites) |
| `ruleCount` | admitted | `tag-rules.ts:215` |
| `schemaVersion` | admitted | `bases.ts:3064` |
| `status` | admitted | `pages.ts:1536` |
| `storedBytes` | missing | `sdk.ts:259` |
| `suggestedAction` | admitted | `agenda.ts:205`, `agenda.ts:480`, `agenda.ts:495` (+222 other callsites) |
| `suggestions` | admitted | `agenda.ts:551`, `agents.ts:595`, `artifacts.ts:512` (+71 other callsites) |
| `timeoutSeconds` | admitted | `instances.ts:1495` |
| `totalGaps` | admitted | `crm.ts:1210` |
| `turn` | admitted | `agenda.ts:441`, `meetings.ts:1628`, `pages.ts:521` |
| `visibility` | admitted | `pages.ts:2681` |
| `warnings` | admitted | `crm.ts:1298` |
| `widgets` | admitted | `pages.ts:2755` |
| `written` | admitted | `cloud-agents.ts:1580` |

## Dynamic/wrapper callsites passed to wrapper auditor

- `src/cli/commands/sessions.ts:7549`: `access.denialDetails`
- `src/cli/commands/agenda.ts:441`: `meetingReadRefusalDetails(block, {                 otherPerson:                   "Tell the person you cannot look at or change the operator's calendar here; the operator can ask i`
- `src/cli/commands/tasks.ts:1958`: `cloudAccess.denialDetails`
- `src/cli/commands/cloud-agents.ts:1303`: `turnRefusalDetails(refusal.reason)`
- `src/cli/commands/meetings.ts:1656`: `failure.details`
- `src/cli/commands/pages.ts:521`: `failure.details`
- `src/cli/commands/context.ts:1413`: `error.details`
- `src/cli/commands/watch.ts:563`: `expected.details`
- `src/cli/commands/watch.ts:575`: `safeWatchErrorDetails(error.details)`
- `src/cli/commands/watch.ts:589`: `sqliteCapacity.details`
- `src/cli/commands/bases.ts:3064`: `base.details`

## Wrapper/domain audit

Baseline: `59381599`. AST scan: **828** non-test source files outside `src/cli/commands`, **199** recognized constructor/helper sites. Dynamic delegations were followed manually. The emitter audit is separate from the focused and complete command tests recorded in the PR.

### Controls missing from the baseline projection

| Field | Producer | Required shape / decision |
|---|---|---|
| `contrast` | src/cli/library-contract.ts:216 | { ok: boolean, failed: bounded [{ pair: [redacted bounded string, redacted bounded string], ratio: finite nonnegative number, min: finite nonnegative number }] }; restored with typed projection |
| `proposalStatus` | src/cli/library-contract.ts:335; src/library/service.ts:988; src/cli/remote-gateway.ts:866 | draft \| proposed \| published \| superseded \| rejected \| withdrawn; preserve enum |
| `runId` | src/cli/cloud-agents-contract.ts:193; src/cloud-agents/task-dispatch.ts:219 | bounded redacted identifier string (upstream CloudRun.id is string); preserve identifier |
| `expectedSha / actualSha` | src/pr/service.ts:40–41,179–180,198; src/pr/git.ts:63,202–203,230; src/pr/contracts.ts:122–123 | 40 hexadecimal SHA-1 characters; preserve validated hashes; already typed at relay projectPublicationDetails |
| `objectType` | src/pr/service.ts:181,198; src/pr/git.ts:64,204,231; src/pr/contracts.ts:124 | blob \| tree \| commit; preserve enum |
| `routine` | src/cloud-auth/turn-refusal.ts:86 via turnRefusalDetails | literal cron; preserve fixed literal with local TurnRefusal control shape |
| `candidates` | src/library/requests.ts:121–126; type src/library/types.ts:362–380 | bounded array of { installationId: bounded identifier, name: redacted bounded string \| null, online: boolean, reportedAt: valid timestamp \| null }; preserve only these fields; no directory agent instructions/provider/project payload |
| `installUrl / connectUrl` | src/watch/operations.ts:261–262 -> src/cli/commands/watch.ts:621–622 | bounded http(s) URL, credentials/query/fragment redacted by shared redactor; preserve sanitized setup links |
| `missingPermissions / missingCapabilities / unsupportedEventTypes` | src/watch/operations.ts:263–265 -> src/cli/commands/watch.ts:623–625 | bounded arrays of validated short capability/event identifiers; no arbitrary object elements; preserve typed lists |

### Retained controls checked

- **library errors/diagnostics**: `errors`, `warnings`, `issues`, `suggestedAction`, `files`, `diff`, `existing`, `view`, `viewProject`, `conflict`, `currentVersion`, `baseVersion`, `ref`, `scope`, `project`, `archived`, `suggestions`.
- **cloud error/catalog**: `retryable`, `suggestedAction`, `status`, `requestId`, `issues`, `domainSetup`, `linkFlow`, `chatLine`, `chatLinePt`, `replyTo`, `reconnectLink`, `approvalId`, `approvalLink`, `expiresAt`, `retryWith`, `consentLink`, `refusalReason`, `jobId`, `ownerPrincipal`.
- **command access/runtime context**: `stage`, `capability`, `requiredCapability`, `cause`, `context`.
- **runtime control relay**: `retryable`, `activeTurn`, `turnId`, `operation`, `disabledReason`.
- **publication**: `plan`, `partial`, `retryable`, `suggestedAction`.
- **apps/knowledge**: `suggestedAction`, `retryable`, `status`, `requestId`, `issues`, `dryRun`, `plan`.
- **meetings/agenda**: `refusal`, `turn`, `organization`, `suggestedAction`, `chatLine`, `chatLinePt`, `replyTo`.
- **watch**: `retryAfterMs`, `suggestedAction`, `status`, `cause`, `context`.

### Eleven dynamic command delegations

- `src/cli/commands/sessions.ts:7549` → `access.denialDetails`: commandAccessDenialDetails: stage=command_access, capability; retained.
- `src/cli/commands/agenda.ts:441` → `meetingReadRefusalDetails`: suggestedAction, chatLine, chatLinePt, replyTo; retained.
- `src/cli/commands/tasks.ts:1958` → `cloudAccess.denialDetails`: same commandAccessDenialDetails; retained.
- `src/cli/commands/cloud-agents.ts:1303` → `turnRefusalDetails(refusal.reason)`: refusalReason/jobId/ownerPrincipal retained; routine missing.
- `src/cli/commands/meetings.ts:1656` → `failure.details`: meeting read refusals: refusal/organization/turn/suggestedAction/chatLine/chatLinePt/replyTo retained.
- `src/cli/commands/pages.ts:521` → `failure.details`: describeAccessFailure: action/linkFlow/refusal controls retained; routine missing via TurnRefusal; raw reason deliberately excluded.
- `src/cli/commands/context.ts:1413` → `error.details`: RuntimeContextError: requiredCapability retained; free-text reason remains excluded.
- `src/cli/commands/watch.ts:563` → `expected.details`: already contracted expected error; inspect source mappers covered by audit.
- `src/cli/commands/watch.ts:575` → `safeWatchErrorDetails(error.details)`: retryAfterMs retained; five setup/capability/event fields missing as listed above.
- `src/cli/commands/watch.ts:589` → `sqliteCapacity.details`: retryable/suggestedAction plus cause/context; retained.
- `src/cli/commands/bases.ts:3064` → `base.details`: cloudErrorToContractError projections covered; explicit Bases additions handled by direct-command audit.

### Deliberate exclusions and pre-existing boundaries

- **reason** (src/cli/library-contract.ts:329; src/library/service.ts:986; src/knowledge/errors.ts:59; src/runtime/context-errors.ts:105; src/access/client.ts:587): free-form upstream text is not a control. Library already supplies conflict; other wrappers supply normalized message/cause and typed refusal. Do not open arbitrary reason passthrough.
- **source=connector-turn** (src/link/connectors.ts; src/link/connector-turn.ts): internal trust discriminator only; connectorTurnCopy explicitly projects its declared chat/action keys
- **consentRef, challengeId, raw response details** (src/link/client.ts; src/identity-link/turn-link.ts): credential/transport internals; mapped to declared consent/approval links or linkFlow upstream, never copy arbitrary details
- **body, headers, cookies, stack, values, arbitrary exception/provider properties** (all wrappers): excluded from diagnostics by original contract; new control shapes must not reintroduce them
- **supportedEventTypes, requestedEventTypes, missing** (src/watch/operations.ts:228–229,249): these are not emitted by the command: safeWatchErrorDetails already excluded them before this PR. Recorded as pre-existing mapper boundary, not a regression introduced by projectFailureDetails.

### Evidence and limits

The scan extracts direct object keys and resolves local literals/spreads/conditionals for `ContractError`, `LibraryCommandError`, `RuntimeContextError`, `contractFail`, and `prError`. Dynamic `details` and mapper returns listed above were inspected separately. It is a bounded source audit, not proof over arbitrary dynamic JS aliases.


## Follow-up projection policy

- Contrast and all newly restored control arrays admit at most 32 entries; strings and numbers have per-field validation. Contrast admits only `ok`, two-element `pair`, finite nonnegative `ratio` and `min`.
- Publication hashes, object type, proposal state, routine classification and environment-key names are validated without accepting arbitrary text. SDK drift can be a boolean or a bounded typed list; known local paths are removed from its reason as well as its path field.
- The only admitted top-level `reason` is the local literal `admin_context_exists`; it does not reopen arbitrary provider reasons. Diagnostic reasons still travel in normalized `cause`.
- Candidate machines admit only their ID, display name, online boolean and timestamp. Watch setup URLs/lists use the declared safe projection. Provider bodies, headers, stacks, row values and undeclared keys stay excluded.
- This is a source audit at the stated emitter snapshot, not a new interprocedural proof. Future control shapes require an explicit projector and positive/negative coverage.
