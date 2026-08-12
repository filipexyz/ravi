# Kimi Code Provider Lifecycle Ownership Design

**Status:** Accepted for implementation  
**Supersedes:** the cleanup-failure and post-publication retention decisions in
`2026-08-11-kimi-code-provider-merge-blockers-design.md`

## Goal

Make provider-session ownership transitions linearizable across turns, resets,
deletes, agent/workspace redirects, provider/model changes, expiry, and process crashes.
Once the host stops owning a Kimi locator, an old callback must not restore it,
and the obligation to remove its private transcript must survive a crash or a
temporary filesystem failure.

## Confirmed failures

The current implementation has one root design defect: `lifecycle_generation`
is incremented after every `sessions` update, while callers use an old in-memory
value as though it were a stable ownership epoch. Normal metadata and token
writes therefore make later reset/delete CAS operations fail even without a
competing owner.

The same boundary has three additional holes:

- terminal and skill-state persistence writes provider locators without an
  ownership CAS, so a late callback can resurrect state after reset or redirect;
- `getOrCreateSession` redirects an existing session to another agent/workspace
  and clears its locator without provider cleanup;
- cleanup runs after the database mutation as best effort, so a crash or
  transient disk error can permanently strand transcript and preserved
  reasoning after the only host locator is gone.

## Ownership invariants

1. `lifecycle_generation` is an ownership epoch, not a general row version.
2. Presentation, source, token, heartbeat, TTL-extension, and other metadata
   updates do not change the ownership epoch.
3. Reset, provider-state clear, agent/workspace redirect, provider/model restart,
   and provider-state replacement by a different owner use an exact epoch CAS.
4. A turn captures the epoch that admitted it. Every later write of provider
   identity, locator, or provider session params must match that epoch.
5. A lifecycle CAS winner advances the epoch in the same SQL statement. A delete
   removes the row under the same CAS. A loser does not change in-memory state,
   report success, revoke contexts, schedule replay, or enqueue cleanup.
6. A late terminal, skill hook, or launcher continuation that lost ownership is
   discarded from durable session state. It cannot resurrect a locator.
7. Removing or superseding a Kimi locator and recording its cleanup obligation
   are one SQLite transaction. Physical deletion is at-least-once and fenced.
8. Cleanup payloads contain only a canonical, allowlisted locator and optional
   successor locator. They never contain transcript messages, reasoning, tool
   output, credentials, headers, or raw provider errors.
9. A snapshot file is never published before a durable provisional-cleanup
   reservation exists. Host adoption of that snapshot consumes the reservation
   in the same transaction that persists the locator.

## Decision 1: explicit ownership epoch

The database migration first executes
`DROP TRIGGER IF EXISTS sessions_lifecycle_generation_after_update`, including
for databases upgraded from the current PR. Only after the trigger is gone may
normal session writes run. Epoch changes become explicit in the lifecycle SQL
that owns them. A migration regression must create an old-schema database with
the trigger, reopen it through current initialization, and prove metadata writes
no longer advance the epoch while lifecycle writes do.

| Mutation | Epoch behavior | Provider-state condition |
|---|---|---|
| source/context/display/token/heartbeat/TTL metadata | unchanged | none |
| turn terminal or provider metadata callback | unchanged | `WHERE session_key = ? AND lifecycle_generation = ?` |
| reset or stale-state clear | `N -> N+1` | exact CAS, locator cleared |
| agent/workspace redirect | `N -> N+1` | exact CAS, owner replaced, locator cleared |
| provider/model restart | `N -> N+1` | exact CAS, locator cleared |
| delete/expiry | row deleted | exact CAS |

Provider persistence additionally compares the previously observed locator when
one exists. This prevents two callbacks admitted under the same epoch from
blindly replacing each other's lineage. The mutation returns the current epoch
and whether it won; callers update local state only on a win.

## Decision 2: durable provider-cleanup tombstones

Use a dedicated local table rather than `sync_outbox`. The sync outbox models
remote delivery (`sent`/`acked`) and would expose private locator semantics to an
unrelated replication surface. A filesystem sweeper cannot atomically prove that
the host stopped owning a path and is not the source of truth.

The cleanup table records:

- opaque task id and deterministic idempotency key;
- provider and operation (`provisional_exact`, `delete_state`, or
  `retire_revision`);
- canonical locator JSON and, for retirement, canonical successor locator JSON;
- `prepared`, `published`, `leased`, `failed`, or `dead` status;
- nullable `owner_attempt_id`, `owner_session_key`, and `owner_boot_epoch`; all
  three are required for `provisional_exact` and absent for ordinary
  delete/retirement tasks;
- bounded attempt count, next-attempt time, lease id/expiry, allowlisted error
  code, and timestamps.

There is no foreign key to `sessions`, because deleting the session must not
delete its outstanding cleanup obligation. Successful cleanup deletes the task
row to minimize retained path metadata. A dead task remains visible to an
operator until explicitly remediated.

`locator_json` is generated only by a versioned canonical serializer over these
exact fields, in this order: `schemaVersion`, `provider`, `model`, `sessionId`,
`revision`, `cwd`, `workspaceIdentity.realpath`, `workspaceIdentity.device`,
`workspaceIdentity.inode`, `sessionFile`, and `lastCommittedTurnId`. Unknown
fields and host metadata such as runtime credentials or skill visibility are
excluded before serialization. The UTF-8 payload is bounded to 16 KiB. The
idempotency key is SHA-256 over the operation and canonical locator bytes plus
canonical successor bytes when present.

### Atomic mutation

The session mutation and `INSERT OR IGNORE` tombstone run inside the same
`BEGIN IMMEDIATE` transaction through the repository write-retry boundary.

- CAS loss: rollback/no task.
- CAS win: session mutation and task both commit.
- SQLite error: neither commits.
- crash after commit: the task remains claimable.

Updating a Kimi locator from revision `N` to `N+1` enqueues
`retire_revision(N,N+1)` in the same transaction. Reset/delete/redirect enqueues
`delete_state(N)`.

### Publication reservation

Before linking a new immutable snapshot into its final path, the provider writes
and fsyncs a small publish-intent journal in the same private session directory.
The intent contains the canonical future locator, opaque task id, owning runtime
turn-attempt id, and no transcript/reasoning. It exists to recover the rare case
where filesystem publication succeeds but the SQLite commit itself fails.

The provider then calls `providerStateLifecycle.publishPreparedState`, a generic
service carried by `RuntimeStartRequest`. `prepareSession` receives the ordinary
`RuntimeHostServices`; the request builder converts its scoped lifecycle service
into this start-request callback. The closure owns the session key, admitted
epoch, and current crash-recovery turn attempt, so the provider never receives or
guesses them and no process-global mutable state is used.

The service opens `BEGIN IMMEDIATE`, verifies the live turn-attempt and ownership
epoch, inserts a `prepared` `provisional_exact` task, invokes a bounded
synchronous provider-owned publication callback (`link`, directory sync, temp
unlink), marks the task `published`, and commits. Holding the SQLite writer lock
prevents a cleanup claim from interleaving with the exact link. The callback is
the only synchronous filesystem segment; snapshot serialization, temp write,
and temp fsync remain outside the database transaction. It uses synchronous fs
primitives and must finish within a configured short deadline; timeout or error
rolls back SQLite and leaves the intent journal for reconciliation. No Promise or
`await` is permitted inside the repository's synchronous `executeWrite` callback.

On POSIX, publication uses a no-replace hard link followed by directory fsync.
On Windows, Bun/Node directory `fsync` is not a usable durability primitive (it
returns `EPERM` on the supported Windows runtime). The Windows path therefore
uses the documented `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` no-replace rename,
which does not return until the move is on disk. Because Bun FFI is explicitly
experimental, the call is made through a fixed P/Invoke helper launched
synchronously with a strict timeout, minimal environment, hidden window, and no
provider data on stdout. Process timeout, non-zero exit, or an ambiguous result
rolls back SQLite and retains the fsynced intent; it is never treated as success.
The same write-through rename publishes the intent journal during async
preparation, before the SQLite critical section. The bounded Windows subprocess
is the sole platform exception to the ordinary no-subprocess callback rule.

Windows cleanup cannot claim durable directory-unlink semantics from `fsync`.
It first write-through-renames each exact owned artifact to a deterministic
private tombstone, durably removing the canonical locator/intent/temp name, then
truncates and flushes the tombstone before best-effort unlink. A crash may leave
only a zero-length private tombstone; it must not leave transcript or reasoning
under either the canonical or tombstone name. Retry recognizes and removes its
own exact tombstone. POSIX cleanup uses unlink followed by directory fsync. In
both cases the matching intent remains until the final/temp canonical names are
durably absent, so no deletion is acknowledged from a one-phase best-effort
unlink.

If the callback publishes and a later SQLite operation or commit fails, the
fsynced intent journal remains authoritative recovery evidence. A bounded
provider-intent reconciler validates the journal and examines journal, matching
task, session ownership, and owning turn attempt together under `BEGIN
IMMEDIATE`. An active attempt retains the journal and creates no claimable task;
an existing matching task is a no-op; an exactly owned locator removes the
journal; only an inactive/expired valid attempt with no owner inserts or revives
the exact `published` task. The reconciler cannot run between the prepared insert
and link because the publisher holds the same writer lock. It never infers
ownership by scanning arbitrary revision files.

Intent discovery is exposed as a bounded, process-local scanner rather than a
string cursor over a rescanned directory tree. Its opaque cursor retains the
open root/session directory handles between pages, advances at most the
configured scan budget per call, and is explicitly closed by the caller (or by
process exit). A page returns typed candidates: canonical intent, Windows
staging intent, or invalid entry with only an allowlisted state-error code.
Invalid entries cannot poison later candidates. The cursor is not persisted;
after a crash the next startup restarts at the beginning, while already
reconciled entries have been removed and therefore cannot permanently starve
the tail. The scanner never returns transcript, reasoning, tool output, raw
error text, or parsed host metadata.

On Windows, the intent staging file is itself valid recovery evidence. If the
write-through staging-to-canonical move times out or is otherwise ambiguous,
the scanner validates and surfaces whichever of staging/canonical exists. If
both exist, their canonical bytes/task/attempt binding must match before the
staging duplicate can be removed. A staging-only intent is reconciled under the
same attempt/session/task fences as a canonical intent; it is never ignored.

Publication stops if the service fails. Its opaque reservation id is carried as
a top-level, host-only field of `RuntimeSessionState`; it is not part of locator
params or snapshot JSON.

On `turn.complete`, the host performs one transaction that:

1. verifies the session ownership epoch and expected prior locator;
2. verifies that the provisional task is still unclaimed and matches the exact
   canonical new locator;
3. persists the new locator;
4. consumes the provisional task; and
5. enqueues predecessor retirement when applicable.

If the host CAS loses, the provisional task remains eligible and the terminal
state is not persisted. Adoption always precedes terminalizing the owning crash-
recovery attempt as complete. Cleanup may claim a provisional task only after its
owning attempt is non-running or its durable lease has expired. If a cleanup
worker claimed first, host adoption loses rather than persisting a possibly
deleted file. A crash before file publication leaves only a private intent/temp;
a crash after publication leaves a durable task or recoverable intent that
removes the orphan; a crash after host adoption leaves the locator owned and
predecessor retirement durable.

The task state machine is:

`prepared -> published -> leased -> completed (row removed)` or
`leased -> failed -> leased`; a non-retryable result is `leased -> dead`.
Only `publishPreparedState` may create/advance `prepared -> published`. Only host
adoption may consume `published` without deletion. Only the cleanup claimant may
advance `published|failed -> leased`, and only its matching lease may complete or
fail the task. `prepared` is never worker-claimable.

The provisional claim query includes an atomic join/check against
`runtime_turn_attempts`: `owner_attempt_id` must match an existing attempt whose
status is not `running`, or whose durable `lease_expires_at <= now`. A missing or
structurally invalid attempt holds the task as `dead`/manual review; it never
makes deletion eligible by default. The attempt's recorded provider, session key,
and boot epoch must match the scoped reservation metadata.

If host adoption loses its ownership CAS, the old runtime does not project or
persist terminal success. It terminalizes its still-owned crash-recovery attempt
as `aborted` with an allowlisted ownership-loss reason, stops the attempt
heartbeat, closes the provider handle, and performs no later terminal callback.
That durable non-success transition makes the provisional task claimable.

`provisional_exact` has its own executor. It validates the intent, root,
containment, reparse status, and exact immutable filename, confirms no host
session owns the canonical locator, and unlinks only that exact future revision
plus its intent/temp. It MUST NOT invoke `cleanupKimiCodeSessionState`, prune
`<= revision`, remove a predecessor, or remove a non-empty parent directory.

`delete_state` and `retire_revision` also have worker-facing durable Kimi
executors, distinct from the source-compatible legacy cleanup wrappers. They
accept canonical locator bytes and an opaque validated task id. `delete_state`
validates the locator-bound snapshot and removes only provider-owned published
revisions at or below the owned revision; `retire_revision` additionally
validates the canonical successor and removes only the exact predecessor.
POSIX variants require unlink followed by strict directory fsync; unsupported
directory fsync fails closed. Windows variants use task-id-bound write-through
tombstones, truncate+flush them before best-effort unlink, and safely retry
partial/zero-length tombstones. The generic ledger is completed only after
these durable variants return. Legacy `cleanupKimiCodeSessionState` and
`retireSupersededKimiCodeSessionState` remain compatibility APIs and do not
constitute worker durability evidence.

Full deletion is batch-bounded. `executeKimiCodeDeleteStateCleanup` returns
`{ complete, processed }`; it uses an incremental directory iterator, performs
at most the fixed per-invocation scan/work budget, and returns `complete:false`
when another leased invocation is required. The runner renews or requeues the
same durable task and must not delete the ledger row until a final bounded pass
returns `complete:true`. Every Windows tombstone name binds the operation, task
id, exact source filename/revision, and a digest of that source identity;
non-zero tombstones are parsed and snapshot-bound before truncation. Retirement
is exact/single-artifact and continues to return only after its predecessor is
durably absent. Credential-bearing recovered artifacts classify as
`credential_detected`, never generic binding mismatch.

This service is a generic runtime-provider lifecycle interface with a registry
of provider cleanup executors. The launcher, bot, channels, and task code do not
branch on `kimi-code`; only the registered Kimi executor understands its locator
and filesystem representation.

### Worker and retry

A provider-cleanup runner performs a bounded startup drain, runs periodically,
and may be kicked after an in-process mutation. Claiming is transactional and
uses a unique lease. Filesystem work happens outside SQLite. Completion/failure
updates require both task id and lease id, so an expired worker cannot finalize a
new owner's claim.

The executor registry and intent reconcilers are installed before cleanup drain
and before runtime intake starts. A task for an unavailable/unknown executor is
held with an allowlisted `executor_unavailable` code; it is never deleted or
interpreted by another provider.

Retries use bounded exponential backoff. Transient I/O/lock failures retry;
invalid schema, snapshot-binding mismatch, traversal, foreign root, and reparse
violations fail closed as `dead`. Only an allowlisted error code is persisted.
The existing Kimi cleanup functions remain the authority for locator binding,
containment, private-root, and idempotent deletion checks.

Cleanup classification never parses `Error.message`. The state layer exposes a
typed non-secret code from this closed set: `state_missing`, `io_transient`,
`state_busy`, `invalid_locator`, `schema_mismatch`, `binding_mismatch`,
`foreign_root`, `reparse_detected`, `credential_detected`, or `unknown`. The
worker owns an exhaustive code-to-retry/dead mapping; `unknown` fails closed and
is not retried automatically.

## Decision 3: redirect is a lifecycle operation

Agent or canonical workspace changes cannot remain a side effect hidden inside
an unguarded `getOrCreateSession` update. The redirect uses the same epoch CAS and
cleanup transaction as reset. It returns a freshly read `SessionEntry` carrying
the new epoch. A turn admitted by the former owner then loses every provider-state
CAS.

Callers that only need creation/read behavior keep a synchronous API. Callers
that may redirect use the ownership-aware transition. Any compatibility wrapper
must delegate to the same transaction; it may not clear locator columns directly.

## Decision 4: recovery is conditional on reset ownership

Context-window recovery may clear local provider state and enqueue a replay only
after reset CAS succeeds. On CAS loss it re-reads the current session and stops
the old recovery path with a deterministic conflict diagnostic. It must not claim
that the session reset, revoke the current owner's contexts, or replay against an
unknown owner.

The same outcome rule applies to automatic deletion, expiry, slash/TUI/CLI reset,
task terminal cleanup, and route conflict cleanup: counts and success messages
describe only committed CAS winners.

## Crash and concurrency boundaries

| Boundary | Required result |
|---|---|
| metadata update between admission and reset | epoch unchanged; reset can win |
| reset wins before late `turn.complete` | terminal provider write loses; no resurrection |
| redirect wins while old worker runs | old worker loses; old locator queued exactly once |
| crash after intent, before publication transaction | reconciler removes aged temp/intent after attempt loss |
| crash during link/SQLite commit | intent recreates the exact provisional task |
| crash after committed link, before host adoption | provisional task deletes the exact orphan after attempt loss |
| crash after lifecycle DB commit | tombstone survives and is reclaimed |
| crash after claim before unlink | lease expires; idempotent retry completes |
| filesystem unavailable | task becomes failed with backoff; locator payload retained |
| invalid/foreign locator | no filesystem mutation; task becomes dead |
| two cleanup workers | one live lease finalizes; duplicate physical execution is harmless |
| terminal CAS loses after snapshot publish | provisional task remains claimable; durable session remains unchanged |

## Live release gates

The public test suite contains no real key or response content. Private tests use
a newly issued secret supplied outside chat and retain only structural/redacted
evidence:

- L-01: `k3-256k` streamed text, usage availability, and exactly one terminal;
- L-02: `k3` with canonical `max`, reasoning observed structurally but never
  persisted to public output/log evidence;
- L-03: harmless host tool executes once, native id is returned, continuation
  completes, and preserved reasoning remains private;
- L-04: abort yields one interruption, plus naturally available rate/quota error
  classification. Quota must never be induced by wasteful requests.

No live gate may print request bodies, response text, reasoning, headers, account
identifiers, or credentials. The PR remains request-changes until all four private
gates have current evidence; skipped tests are not evidence.

## Focused validation

Implementation follows RED-to-GREEN tests for only the changed boundaries and
their direct dependencies:

- ownership epoch stability under metadata updates;
- reset/redirect/delete CAS winner and loser outcomes;
- late terminal/skill/launcher writes after reset;
- transaction rollback and crash-after-commit tombstone recovery;
- publish-intent recovery and the claim/link/adopt race matrix;
- CAS-loss terminalization and attempt-fenced claim eligibility;
- lease expiry, duplicate claim, retry/dead classification, and payload redaction;
- context-window recovery on CAS win/loss;
- agent/workspace redirect cleanup;
- live test structure and opt-in gating without a network call by default.

Repository-wide Bun tests are delegated to upstream Linux CI. Local verification
uses the explicit affected tests, typecheck for touched TypeScript boundaries,
diff checks, documentation links, and the public sanitization gate.
