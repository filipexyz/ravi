# Kimi Code Provider Lifecycle Ownership Implementation Plan

> **Execution:** Use subagent-driven development with a task-scoped implementation review after every task.

**Goal:** Make provider-session ownership race-safe and make every Kimi transcript cleanup obligation survive crashes and transient filesystem failure.

**Design:** [Kimi Code Provider Lifecycle Ownership Design](../specs/2026-08-11-kimi-code-provider-lifecycle-ownership-design.md)

**Tech stack:** Bun, TypeScript, Bun SQLite, RAVI runtime provider contract.

## Global constraints

- Never use, store, print, or transmit a credential exposed through chat.
- No live Kimi request until a newly issued credential is provided by an approved private secret channel.
- Local tests are limited to the behavior changed by the task and its direct dependencies. Repository-wide tests run in upstream Linux CI.
- All production filesystem deletion remains rooted, canonical, reparse-safe, snapshot-bound, and idempotent.
- Cleanup durable payloads contain only canonical locator fields. They never contain transcript, reasoning, tool output, raw errors, headers, account ids, or credentials.
- `lifecycle_generation` is an ownership epoch. Metadata-only writes never advance it.
- No provider-specific branch may be added to bot, launcher, channel, or task code. Provider-specific logic lives behind the generic lifecycle executor registry.
- Every bugfix starts with a focused failing regression and ends with that regression green.
- Use `rtk` for every shell command.

---

### Task 1: Correct the session ownership epoch

**Files:**

- Modify: `src/router/router-db.ts`
- Modify: `src/router/sessions.ts`
- Modify: `src/router/types.ts` only if the returned mutation type requires it
- Test: `src/router/sessions.test.ts`
- Test: `src/router/sessions.provider-state.test.ts`
- Test: the closest router migration test, or a new focused migration test beside it

**Required interfaces:**

- Metadata writes leave `lifecycle_generation` unchanged.
- Reset, clear, redirect, provider/model restart advance `N -> N+1` under exact CAS.
- Provider-state persistence accepts the admitted epoch and expected prior locator; it returns a typed win/loss result and never writes on loss.
- Existing databases drop `sessions_lifecycle_generation_after_update` during initialization.

- [ ] Add RED: upgrade a DB containing the old trigger; reopen and prove the trigger is removed.
- [ ] Add RED: source/context/token/heartbeat/TTL/provider metadata updates do not change epoch.
- [ ] Add RED: reset/clear/redirect winner advances epoch once; stale repeat loses.
- [ ] Add RED: provider terminal persistence after a winning reset loses and cannot restore locator.
- [ ] Implement explicit epoch SQL and typed CAS results.
- [ ] Run only the router migration/session/provider-state tests and targeted Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 2: Add the durable cleanup task store

**Files:**

- Modify: `src/router/router-db.ts`
- Add: `src/runtime/provider-state-cleanup-store.ts`
- Add: `src/runtime/provider-state-cleanup-store.test.ts`
- Modify: `src/router/index.ts` only for required generic exports

**Required interfaces:**

- Dedicated cleanup table with the exact state machine and `owner_attempt_id` in the design.
- Canonical locator serializer is versioned, field-allowlisted, stable, and capped at 16 KiB.
- Session lifecycle CAS plus enqueue is one `BEGIN IMMEDIATE` transaction.
- Claim is lease-fenced; provisional claim joins the owning runtime attempt and fails closed when missing/corrupt.
- Completion/failure requires task id plus lease id. Errors persist only a closed allowlisted code.

- [ ] Add RED for schema upgrade/idempotence and no FK cascade.
- [ ] Add RED for transaction rollback, CAS loss/no task, CAS win/task committed.
- [ ] Add RED for canonical payload redaction and stable idempotency hash.
- [ ] Add RED for prepared non-claimability, published claim after attempt terminal/expiry, active-attempt hold, missing-attempt dead.
- [ ] Add RED for lease expiry/reclaim, stale lease completion loss, retry backoff, and dead classification.
- [ ] Implement store using `executeWrite`; no filesystem operation inside this task.
- [ ] Run only store/router migration tests and targeted typecheck/Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 3: Add typed Kimi state errors, exact cleanup, and publish intent

**Files:**

- Modify: `src/runtime/kimi-code-state.ts`
- Modify: `src/runtime/kimi-code-state.test.ts`

**Required interfaces:**

- Typed non-secret `KimiCodeStateErrorCode` closed set from the design.
- Canonical Kimi locator projection/parse API shared with the generic store without exposing messages or host metadata.
- A private fsynced publish-intent journal contains only canonical locator, task id, owner attempt id.
- A prepared snapshot exposes a synchronous bounded publish callback; no async filesystem operation occurs inside the SQLite callback.
- POSIX publication uses link plus directory fsync; Windows uses bounded `MoveFileExW(..., MOVEFILE_WRITE_THROUGH)` P/Invoke because Bun directory fsync returns `EPERM`, retaining intent on timeout/ambiguity.
- `provisional_exact` cleanup deletes only the exact future revision and its intent/temp after proving no host owner; it never prunes `<= revision`.
- Intent discovery uses a closeable process-local scanner cursor with typed canonical/staging/invalid candidates; every page has a hard scan budget and never rescans its prefix.
- Worker-facing durable `delete_state` and `retire_revision` executors use canonical locators plus a validated task id; legacy wrappers remain compatibility-only.
- Durable full delete returns `{ complete, processed }` under a hard per-call scan/work budget; the worker requeues/renews incomplete batches and completes the ledger only after a final empty pass.
- Existing full-session cleanup and predecessor retirement retain their present binding/reparse guarantees.

- [ ] Add RED for each typed error class without parsing messages.
- [ ] Add RED proving unknown locator/host metadata never enters canonical bytes.
- [ ] Add RED at crash boundaries: before intent sync, after intent, after link, after directory sync.
- [ ] Add RED proving exact provisional cleanup preserves the currently owned predecessor and newer unrelated revisions.
- [ ] Add RED for reparse, foreign root, binding mismatch, missing exact file, and idempotent exact deletion.
- [ ] Implement prepare/publish/reconcile primitives and exact executor.
- [ ] Run only Kimi state tests and targeted typecheck/Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 4: Add the generic provider lifecycle service and worker

**Files:**

- Modify: `src/runtime/types.ts`
- Modify: `src/runtime/host-services.ts`
- Modify: `src/runtime/runtime-provider-bootstrap.ts`
- Modify: `src/runtime/runtime-request-builder.ts`
- Add: `src/runtime/provider-state-lifecycle.ts`
- Add: `src/runtime/provider-state-lifecycle.test.ts`
- Add: `src/runtime/provider-state-cleanup-runner.ts`
- Add: `src/runtime/provider-state-cleanup-runner.test.ts`
- Modify daemon startup/shutdown wiring where the generic runner belongs

**Required interfaces:**

- `RuntimeStartRequest` receives a request-scoped provider-state lifecycle service bound to session key, admitted epoch, and crash-recovery attempt.
- Generic executor registry is installed before intent reconciliation, cleanup drain, and runtime intake.
- `publishPreparedState` holds `BEGIN IMMEDIATE`, inserts prepared task, invokes sync callback, marks published, commits.
- Reconciler examines intent/task/session/attempt atomically per design.
- Runner uses bounded startup drain, periodic drain, leases, allowlisted diagnostics, and unknown-executor hold.
- No `kimi-code` branch outside executor registration.

- [ ] Add RED for request scoping and no process-global cross-talk across two sessions.
- [ ] Add RED for prepared/link/published ordering and callback rollback.
- [ ] Add RED for commit ambiguity recovered from intent.
- [ ] Add RED for active-attempt reconciliation hold and inactive exact-task recreation.
- [ ] Add RED for executor registration/startup order and unknown executor behavior.
- [ ] Implement service/runner and register Kimi executor behind generic API.
- [ ] Run only new lifecycle/store/request-builder/bootstrap/daemon wiring tests and targeted typecheck/Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 5: Wire terminal adoption and stop locator resurrection

**Files:**

- Modify: `src/runtime/kimi-code-provider.ts`
- Modify: `src/runtime/host-event-loop.ts`
- Modify: `src/runtime/session-launcher.ts`
- Modify: `src/runtime/skill-gate.ts` or its generic persistence callback owner
- Modify: `src/runtime/provider-session-lifecycle.ts` as needed to delegate to the new generic service
- Test: `src/runtime/kimi-code-provider.test.ts`
- Test: `src/runtime/session-trace.test.ts` only the exact lifecycle cases
- Test: `src/runtime/runtime-request-builder.crash-recovery.test.ts`

**Required behavior:**

- Kimi publishes only through `publishPreparedState`; returned session carries reservation id outside params/snapshot.
- `turn.complete` adopts locator, consumes provisional task, and enqueues predecessor retirement in one ownership CAS transaction.
- CAS loss does not update in-memory provider state, backfill ids, record success, or project terminal success.
- CAS loss terminalizes the old attempt as aborted/ownership-lost, stops its heartbeat, closes provider handle, and leaves provisional exact cleanup claimable.
- Launcher/skill callbacks cannot restore provider state after ownership loss.

- [ ] Add RED for reset winning immediately before terminal persistence.
- [ ] Add RED for redirect winning immediately before terminal persistence.
- [ ] Add RED for skill/launcher callback after reset.
- [ ] Add RED for published snapshot + lost adoption -> aborted attempt + exact cleanup task.
- [ ] Add RED for successful adoption -> locator owned + provisional consumed + predecessor retirement queued.
- [ ] Implement terminal/launcher/skill integration.
- [ ] Run only provider, affected trace cases, request-builder crash-recovery tests, and targeted typecheck/Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 6: Route every lifecycle mutation and outcome through the durable boundary

**Files:**

- Modify: `src/router/sessions.ts`
- Modify: `src/runtime/session-resolver.ts`
- Modify: `src/runtime/host-event-loop.ts`
- Modify: `src/runtime/host-subscriptions.ts`
- Modify: `src/ephemeral/runner.ts`
- Modify only catalogued CLI/TUI/slash/omni/route paths that still bypass or misreport the generic boundary
- Test the exact corresponding existing test files

**Required behavior:**

- Agent/workspace redirect is an ownership CAS and durable cleanup transaction, not a direct `getOrCreateSession` side effect.
- Context-window recovery continues only after reset win; loss re-reads current state and stops old recovery.
- Auto-delete/expiry/task terminal/route conflict counts and messages include only committed winners.
- No productive reset/clear/delete/redirect path bypasses the generic durable lifecycle API.
- Idle eviction and daemon shutdown preserve resumable state.

- [ ] Run a read-only call-site inventory and turn each remaining bypass into a named RED case.
- [ ] Implement redirect API and migrate productive call sites.
- [ ] Add RED/GREEN for context recovery CAS loss and no false success.
- [ ] Add RED/GREEN for expiry/task/route count accuracy.
- [ ] Re-run the call-site inventory and prove zero productive bypasses.
- [ ] Run only changed lifecycle/call-site tests and targeted typecheck/Biome/diff check.
- [ ] Commit and obtain task review approval.

### Task 7: Replace the private live scaffold with L-01 through L-04

**Files:**

- Modify: `src/runtime/kimi-code-provider.live.test.ts`
- Add or modify a focused offline test for the live evidence reducer/harness
- Modify: `.ravi/specs/runtime/providers/kimi-code/CHECKS.md` only with actual evidence

**Required behavior:**

- Default execution skips all live gates without network.
- Harness passes only minimum env, uses isolated temporary `RAVI_STATE_DIR`, and deletes it in `finally`.
- L-01 fixes `k3-256k` and asserts text streaming, usage, and one terminal.
- L-02 fixes `k3` + `max`, asserts structural reasoning, and exposes no reasoning content.
- L-03 executes one harmless synthetic tool exactly once and proves continuation.
- L-04 proves one abort terminal; any naturally observed quota/rate outcome is classified through the real host classifier. It must not deliberately exhaust quota.
- Evidence reducer retains only counts/booleans/allowlisted classification; never text, prompts, ids, paths, headers, raw events, reasoning, or credentials.

- [ ] Add offline RED/GREEN tests for env minimization, temp cleanup, reducer allowlist, and no-network skip.
- [ ] Implement L-01..L-04 opt-in tests.
- [ ] Run only live harness offline tests; confirm all four network cases skip without opt-in.
- [ ] Commit and obtain task review approval.
- [ ] Keep release blocked until a new private credential runs all four gates.

### Task 8: Completion audit, adversarial review, and PR update

- [ ] Build a requirement-to-evidence matrix for every invariant and L-01..L-04.
- [ ] Run only the explicit affected tests recorded by Tasks 1–7, sequentially.
- [ ] Run typecheck/build once after integration, targeted Biome, docs links, spec checks, diff check, and public secret/company-data sanitization.
- [ ] Dispatch whole-branch adversarial review covering concurrency, crash consistency, privacy, protocol, platform paths, lifecycle outcomes, and differential behavior versus Codex/Claude.
- [ ] Fix all Critical/Important findings in one scoped wave and obtain one scoped re-review.
- [ ] Push the existing PR branch and use upstream Linux CI as the repository-wide regression gate.
- [ ] Do not merge while L-01..L-04 lack current private evidence.
