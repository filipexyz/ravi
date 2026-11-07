---
id: runtime/defaults
title: "Runtime Defaults"
kind: capability
domain: runtime
capabilities:
  - runtime-defaults
tags:
  - runtime
  - model
  - provider
  - settings
applies_to:
  - src/runtime/runtime-defaults.ts
  - src/runtime/runtime-selection.ts
  - src/runtime/task-runtime-context.ts
  - src/runtime/session-resolver.ts
  - src/cli/commands/settings.ts
  - src/cli/commands/sessions.ts
  - src/cli/commands/agents.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Runtime Defaults

## Intent

Operators need one stored, live-readable way to set the provider, model, and
effort that the next unshadowed turn actually uses. Environment variables are
last-resort fallbacks, never the live source of truth.

## Operator Method

Set or clear the stored global defaults through the existing settings surface:

```bash
ravi settings set runtime.defaultProvider claude
ravi settings set runtime.defaultModel opus
ravi settings set runtime.defaultEffort high
ravi settings delete runtime.defaultModel --execute
ravi sessions info <session> --json
ravi agents show <id> --json
```

Session (`ravi sessions set-model` / `set-provider` / `set-effort`), agent
(`ravi agents set`), preset, and task/profile overrides remain the higher
precedence knobs. This capability does not add a fifth override namespace.

`settings set` stays unbraked. `settings delete` remains dry-run unless
`--execute`.

## Precedence

Provider, model, and effort are independent axes. Highest first:

1. launch / observation / prompt / dispatch / task / profile override
2. session override (`ravi sessions set-provider`)
3. last-used `session.runtimeProvider` (source `last_used`) or daemon-restart
   snapshot provider (source `restart_snapshot`)
4. agent preset or direct agent value
5. stored global setting (`runtime.defaultProvider`, `runtime.defaultModel`,
   `runtime.defaultEffort`) — source `global_default`
6. env fallback (`RAVI_MODEL` only; no provider/effort env sibling) — source
   `env_fallback`
7. hardcoded last resort — source `runtime_default`

Last-used and restart-snapshot providers are continuity hints, not explicit
overrides. They MUST win over agent/global defaults when no launch,
observation, or session `set-provider` override is present. They MUST NOT
clear a compatible stored provider session id.

A stored setting MUST win over env. Env MUST NOT win over a stored
agent/session/settings/preset value.

## Display Matches Launch

`resolveRequestedRuntimeProvider` and `resolveEffectiveSessionRuntime` are the
canonical next-turn resolvers. `sessions info` / `sessions list` and
`agents show` / `agents list` MUST reuse them. Display MUST NOT invent a model
when only a provider override is set.

Each axis MUST report its source. Session JSON exposes `providerSource`,
`modelSource`, `runtimeOptions`, and `modelError` when a referenced preset is
unusable.

## Unusable Presets

A missing, disabled, or provider-incompatible agent preset MUST NOT fall
through to env or the hardcoded model. Launch MUST reject the turn unless a
higher-priority model already won. See `runtime/model-presets`.

## Live Application

Stored settings are read from SQLite on each resolve. The next turn uses the
new values without a daemon restart. `settings set` / `delete --execute` still
emit `ravi.config.changed`.

## Provider/model coherence

- Session model/provider mutations MUST check all required authority before resolving or validating the resulting provider/model pair. This includes agent-default authority for `--propagate` and provider switches. A denied caller MUST receive `PERMISSION_DENIED` without changing agent defaults, the target session, or sibling sessions, even when the requested pair is incompatible. Hidden sessions MUST continue to appear missing.
- Agent create/model/provider mutations and session model/provider mutations MUST validate the resulting effective pair before writing or publishing configuration events. Session validation includes inherited agent/global settings and stored session overrides.
- Known incompatible model families MUST be rejected. Open-ended model ids and custom provider catalogs MUST remain usable; this is not a frozen allowlist of every model.
- Codex-only agent selectors MUST NOT be launched through an inherited Pi runtime. Thread creation MUST reject that pair before publishing a Slack root or creating its lifecycle, with `THREAD_MODEL_INVALID` and guidance to provide `--provider` with `--model`.
- Runtime preflight MUST also reject known incompatible persisted pairs before credential resolution. Existing rows are not silently migrated: operators can inspect the failure and explicitly repair the provider/model pair. No automatic credential/provider fallback may widen authority.
