---
id: sessions/runtime-update
title: Atomic Session Runtime Update
kind: capability
domain: sessions
capability: runtime-update
capabilities:
  - runtime-update
  - model-catalog-validation
  - runtime-probe
tags:
  - sessions
  - runtime
  - models
  - fail-fast
  - cli
applies_to:
  - src/runtime/model-catalog.ts
  - src/runtime/model-validation.ts
  - src/runtime/runtime-probe.ts
  - src/runtime/session-runtime-update.ts
  - src/cli/commands/sessions.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Atomic Session Runtime Update

## Intent

Changing a session's runtime (provider, model, effort, thinking) must never
leave the session on a configuration that cannot complete a turn. Three rules
implement that:

1. **Fail fast at write time.** Every command that writes provider/model/
   effort/thinking validates the full requested selection BEFORE writing. A
   model this installation's catalog does not know is refused immediately,
   naming the valid values. Origin incident (2026-11-13): `create-thread
   --provider claude --model fable-5-2` was accepted and the thread died,
   masked, on its first turn.
2. **Prove it with a live turn.** `ravi sessions update` applies the requested
   axes together and runs a real provider turn (the liveness probe) against
   the persisted effective runtime.
3. **Roll back on failure.** A failed probe restores every touched axis to its
   prior value. Destructive finalization (clearing provider continuity,
   rematerializing agent defaults after a provider clear) is deferred until
   the probe passed, so rollback never reconstructs destroyed state.

## Boundary

This capability owns:

- `checkRuntimeModelInCatalog` in `src/runtime/model-catalog.ts` and its use
  inside `validateRuntimeModelSelector` (`src/runtime/model-validation.ts`);
- the liveness probe (`src/runtime/runtime-probe.ts`);
- the atomic update core (`src/runtime/session-runtime-update.ts`);
- the `ravi sessions update` command.

It does NOT own:

- the catalog's model entries (the provider SDK bump that introduces new
  models updates `model-catalog.ts` alongside it);
- per-axis commands (`set-provider`, `set-model`, `set-effort`,
  `set-thinking`), which keep their semantics and inherit the stronger
  validation through the shared validator;
- agent defaults (`ravi agents set`), which also inherit the validator.

## Rules

- The single source of truth for model recognition is the runtime catalog
  (`src/runtime/model-catalog.ts`). Write paths MUST NOT grow private model
  lists.
- Fail fast MUST NOT become a closed catalog. The write path refuses what can
  never work: empty or malformed values, and families the provider does not
  route (cross-vendor shapes via `modelProviderMismatch`; unknown families via
  the catalog's family check). A KNOWN family with an UNKNOWN version
  (claude-fable-9, claude-mythos-6, claude-sonnet-7, grok-99) passes through
  intact — the provider owns model resolution and fallback, and a version it
  refuses surfaces in the liveness probe with rollback. The local list
  recognizes families and names listed models in refusals; it never forbids a
  new version of a family that exists.
- First-class aliases (sonnet/opus/haiku, fable) keep resolving as before.
- Codex is different: the installation's models cache
  (`$CODEX_HOME/models_cache.json`, overridable with
  `RAVI_CODEX_MODELS_CACHE`) is the account's real model list, so unknown
  slugs are refused there. Hidden cache entries still exist and are accepted;
  suggestions name the listed ones.
- Providers with an open model space (Pi selectors, Codex without a cache,
  unknown provider ids) stay permissive; only the cross-vendor rules of
  `modelProviderMismatch` apply there.
- Under `NODE_ENV=test` there is no default Codex cache path: the developer
  machine's `~/.codex` must not change test outcomes. Tests opt in with an
  explicit `codexCachePath`.
- Rejection messages MUST name both the refused value and the valid values.
- The probe runs out-of-band: scratch cwd, no tools (`allowedTools: []`), no
  chat delivery, no writes to the target session's provider continuity, and
  managed credentials resolved through the same pool as real turns.
- A probe failure leaves the session byte-identical on the four axes and the
  command exits with `RUNTIME_PROBE_FAILED`, carrying the probe error.
- `--skip-probe` applies without proof and says so; it exists for offline or
  bulk-administrative flows, not as the default.
- The model-changed live notification (`ravi.session.model.changed`) is only
  emitted after the probe passed, so a live daemon never hot-switches onto an
  unproven selection — and never for an update a concurrent writer already
  replaced.
- Concurrent updates must not lose each other (lost-update finding on #829).
  Every apply advances the session's persisted
  `runtime_provider_config_revision` exactly once (the provider setter bumps on
  its own; other axis combinations bump explicitly). Rollback is a single
  conditional statement that only applies while the persisted revision AND all
  four persisted values still equal what this update wrote; destructive
  finalization (continuity clear, rematerialization) is gated by the same
  ownership condition. A superseded update reports `superseded: true`, restores
  nothing, destroys nothing, and announces nothing.

## Known windows

- Between apply and a failed probe's rollback, a concurrent inbound turn can
  start on the unproven selection. The window is seconds wide and ends in the
  prior state; removing it entirely would require a session-level write lock,
  deliberately out of scope here.
- Ownership is revision + exact values. A concurrent bare `set-model`/
  `set-effort`/`set-thinking` (which do not bump the revision) is detected by
  the value comparison; the residual blind spot is a concurrent writer that
  wrote byte-identical values without bumping the revision, where a failed
  probe's rollback also erases that identical write. Two concurrent
  `ravi sessions update` runs always detect each other through the revision.
