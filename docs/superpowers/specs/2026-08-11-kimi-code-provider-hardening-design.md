# Kimi Code Provider Hardening Design

## Status and authority

This design hardens the implementation governed by
`.ravi/specs/runtime/providers/kimi-code/SPEC.md`. The RAVI spec remains the
normative source. This document records how the confirmed adversarial findings on
PR #406 will be corrected without widening the provider's advertised capability
surface.

The implementation must remain additive. Claude, Codex, and Pi behavior must not
change unless a generic host defect is demonstrated by a provider-independent
regression.

## Goals

- Make terminal transitions atomic and first-winner deterministic.
- Guarantee exactly one completion for every published tool start.
- Validate the complete native request and every protocol field that affects
  product behavior.
- Preserve actionable, redacted failure phase and classification.
- Make persisted continuity safe across crash, model change, workspace change, and
  orphaned writes.
- Add an operational availability gate for new Kimi Code sessions.
- Close documentation and release-gate drift before merge.

## Non-goals

- Adding media, structured output, MCP, plugins, parallel tools, fork, remote spawn,
  or provider-native shell execution.
- Refactoring Claude or Codex into a new shared provider framework.
- Displaying or publicly persisting preserved reasoning.
- Using a credential disclosed in chat for live verification.

## Chosen architecture

### 1. Atomic turn lifecycle

The provider will track an explicit internal phase independent of generator
suspension points:

```text
initializing -> requesting -> streaming -> committing
             -> tool-fenced -> tool-running -> continuing
             -> completed | failed | interrupted
```

The canonical terminal tracker remains the public exactly-once boundary, while the
internal phase decides which terminal transition is legal. Native success becomes
committed before yielding any post-commit public event. Once committed, later abort
signals are cleanup requests and cannot replace `turn.complete`.

A published `tool.started` creates an obligation. That obligation is discharged by
exactly one `tool.completed`, including a deterministic cancelled result when abort
is observed after the start fence but before host dispatch. The host handler is
never replayed automatically after the start fence.

The provider will emit `thread.started` once for a new transcript, before the first
`turn.started`. It will emit `assistant.message` only when public text is non-empty.

### 2. Native protocol boundary

The completed-turn value will preserve `finishReason`. Tool execution is legal only
when `finishReason === "tool_calls"`; `length` and `content_filter` fail closed and
must never dispatch tools. `tool_calls` without valid calls is a protocol failure.

Tool fragments must have a safe non-negative bounded index. Once an index has an id
or function name, later fragments may omit it or repeat the identical value, but may
not replace it. Arguments remain bounded and are parsed only after terminal assembly.

A stream message is accepted only when it contains a recognized structural field:
valid `choices`, valid usage, or a structured provider error. Unknown fields remain
allowed only as additive fields on a recognized shape.

Token counts must be non-negative safe integers. Additions use checked arithmetic;
overflow is a protocol failure rather than `Infinity` or lossy JSON.

Structured SSE errors retain only allowlisted status, code, type, request id, and
classification inputs. Raw messages, response bodies, prompts, credentials, and
reasoning never enter canonical events.

### 3. Request and transport boundary

System policy is placed before the conversation transcript, matching the semantic
precedence used by Claude and Codex. A multi-turn fixture will freeze the order:

```text
system -> prior transcript -> current user -> assistant tool call -> tool result
```

The preflight serializes the exact native JSON body and enforces the 2 MiB UTF-8
limit on that complete representation before transport handoff. Per-message bounds
may remain as early diagnostics but cannot replace the aggregate check.

Preflight failures use fixed typed errors for missing credentials, unsupported
models, unsupported effort, request size, and invalid session input. They are
non-recoverable and cannot collapse into a generic stream error.

Transport failures carry a redacted handoff phase:

- `request_not_sent`: failure before fetch accepts the request;
- `acceptance_ambiguous`: fetch returned or streaming began and delivery may have
  occurred;
- `provider_protocol`: invalid framing or native structure.

The provider does not replay ambiguous requests. Abort is rechecked immediately
after iteration ends so a real reader cancellation becomes `turn.interrupted`.

Production credentials are attached only after the URL origin equals
`https://api.kimi.com`. Test endpoint substitution must use an explicitly test-only
transport boundary and cannot silently turn an arbitrary URL into an authenticated
production request. Combined abort listeners are removed in transport cleanup.

### 4. Durable continuity

Publishing a snapshot and promoting its locator form one logical commit. A failed or
aborted promotion must not reserve the next deterministic revision forever. Snapshot
filenames will use a collision-safe immutable identity, while the locator promotion
remains the single compare-and-publish point. Orphans may remain for forensic cleanup
but cannot block subsequent commits.

`restart-next-turn` caused by model change starts a clean Kimi transcript. Generic
session resolution must not pass a model-incompatible Kimi locator into the new
provider session.

The locator stores canonical workspace identity in addition to the display cwd. On
POSIX this includes realpath and device/inode where available; on Windows it uses the
strongest identity exposed by the existing runtime without following an unvalidated
reparse point. Resume fails closed if the identity cannot be proven stable. Lexical
path equality alone is insufficient.

Existing credential and skill-visibility metadata remain strictly allowlisted and
secret-scanned.

### 5. Availability and rollout

Provider registration remains discoverable, but starting a new Kimi Code session is
guarded by an explicit host configuration flag. The default is disabled until the
private release evidence is recorded. Disabling the provider prevents new sessions
without deleting persisted state or changing Claude, Codex, and Pi.

The runbook documents enable, disable, canary, rollback, and credential rotation.
Broken references are replaced by repository-local targets that exist in the PR.

## Error handling

Every failure exposes a fixed public message and a bounded diagnostic projection.
Errors distinguish request, credential, account quota, provider overload, protocol,
local interruption, and ambiguous delivery. `recoverable` is never used as a proxy
for safe replay.

No error path may include authorization values, configured key material, prompts,
tool arguments/results, preserved reasoning, local absolute paths, or external
response bodies.

## Test strategy

Each confirmed finding receives a RED test before production changes:

- iterator-controlled races after `tool.started` and after committed success;
- real `ReadableStream` cancellation while `reader.read()` is pending;
- orphan publication followed by a successful later commit;
- aggregate request size and multi-turn system ordering;
- model-switch restart and workspace identity replacement;
- `finish_reason` coherence and zero tool dispatch on truncation/filtering;
- negative/oversized index and immutable tool identity;
- unknown native shape and structured SSE error projection;
- safe-integer usage and checked addition;
- typed preflight and request-handoff ambiguity;
- listener cleanup and origin allowlist;
- availability flag behavior and unchanged existing provider snapshots;
- `thread.started` ordering and suppression of empty assistant messages.

Focused tests, typecheck, build, SDK drift, spec/coverage gate, and the complete CI
suite must pass. Independent reviewers then re-audit the exact fix range.

## Private live verification

Live verification is the final merge gate and requires a newly issued credential
from an approved secret channel. It must capture only redacted structural evidence
for text, preserved reasoning continuity, tools, usage, terminal framing, abort, and
representative errors. No live prompt, reasoning, account identifier, or bearer value
may enter git, CI logs, PR comments, or public artifacts.

The credential previously disclosed in conversation is permanently ineligible.

## Completion criteria

- Every confirmed Important finding has a reproducing regression and a verified fix.
- No Critical or Important finding remains in final independent review.
- Existing Claude, Codex, and Pi contracts remain unchanged.
- Offline gates and public CI pass on the final SHA.
- The private live matrix passes with a fresh credential.
- PR #406 contains no secret, personal path, private reasoning, or private fixture.
