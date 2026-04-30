---
id: runtime/context-keys/skill-gate
title: "Skill-Gated Tool Invocation"
kind: feature
domain: runtime
capability: context-keys
feature: skill-gate
tags:
  - runtime
  - context-keys
  - skills
  - permissions
  - gates
applies_to:
  - src/runtime/context-registry.ts
  - src/runtime/runtime-request-context.ts
  - src/cli/commands/context.ts
  - src/skills/manager.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Skill-Gated Tool Invocation

## Intent

`skill-gate` is the proposed runtime feature that lets a CLI declare "tool X requires skill Y to be loaded in the current session" and have the runtime enforce it before the tool runs. The feature ensures a tool cannot be called by an agent that has not loaded its specialist skill, eliminating an entire class of "tool invoked without context" failures.

The feature exists because today the operator relies on agent prompts and on per-CLI checks to remind the model to consult the right skill. That is fragile: a session can drift past compact or skip discovery and still call a tool. Encoding the dependency at the runtime context layer makes the requirement structural rather than advisory.

## Model

A CLI declares its skill requirement at registration time (manifest, frontmatter, or skill metadata — exact surface is out of scope here). The runtime, holding `RAVI_CONTEXT_KEY` for that invocation, evaluates the gate before forwarding the call.

Three enforcement variants MUST be supported:

### Variant 1 — Hard gate

- If the required skill is NOT in `loadedSkills`, the runtime MUST reject the call with a structured error.
- The error MUST include: the missing skill name, the canonical command to load it, and a stable error code consumers can branch on.
- The tool MUST NOT execute. The agent MUST receive the error and decide whether to load the skill and retry.

### Variant 2 — Soft gate with auto-inject

- If the required skill is NOT in `loadedSkills`, the runtime MUST resolve the skill content and return it to the caller as part of the error payload.
- The runtime MUST add the skill to `loadedSkills` as soon as it is delivered so the agent's next attempt does not re-trigger the gate.
- The tool MUST NOT execute on the first call; the agent MUST acknowledge the injected skill content (i.e. consume it into its working context) before the runtime allows a retry.

### Variant 3 — Passive inject

- The tool MUST execute normally — the gate does NOT abort the call.
- After execution, the runtime MUST prepend the required skill content to the tool output the agent receives.
- The runtime MUST add the skill to `loadedSkills` once the injection happens, so subsequent calls in the same session do not re-inject.
- This variant is intended for tools where the cost of running without the skill is low (the call is informative or idempotent) but where the agent should still acquire the skill for future calls.
- This variant MUST NOT be chosen for tools whose first execution has destructive or expensive side effects, since the skill arrives only after the action. The CLI manifest MUST justify the choice (one-line `passive_safety_rationale`).

The choice between variants is per-CLI declaration. A given tool MUST pick one and document it in the CLI manifest.

## Rules

- The gate MUST evaluate against the live `loadedSkills` vector held by `runtime/skill-loading`. It MUST NOT scan the filesystem on the hot path; if the skill is not in the vector it is treated as not loaded.
- Skill identifiers in gate declarations MUST match the canonical skill name (frontmatter `name`). Aliases or paths MUST NOT be accepted at gate evaluation.
- A gate MUST be enforced before any side effect of the tool. Tools that already started external work when the gate fires are a violation of the contract.
- A gate failure MUST emit a structured event on the runtime event stream tagged with the agent, session, tool, missing skill, and chosen variant.
- The variant selection MUST be visible to the operator (e.g. via `ravi tools show <tool>`). The operator MUST be able to audit which tools are gated and how.
- A tool with no skill-gate declaration is unchanged. The gate MUST be opt-in per tool; the absence of a declaration is treated as no gate.
- The gate MUST be evaluated even if the agent claims to have loaded the skill in its narration. The runtime trusts the vector, not natural language.

## Interaction

- Reads `loadedSkills` from `runtime/skill-loading`. Any inconsistency in that vector becomes a `skill-gate` correctness bug.
- Reads skill metadata from `plugins` (canonical name, description). The gate MUST resolve the skill once at start and cache the metadata for the session.
- Emits visibility events consumed by `runtime/session-visibility` so operators can see gate failures alongside token and compact telemetry.
- Composes inside the pipeline defined by `runtime/transforms` — the gate is one specific transform among many that may run on PreToolUse.

## Composition with `runtime/transforms`

`skill-gate` is a particular case of a PreToolUse transform (see `runtime/transforms`). Specifically:

- **origin**: `builtin`.
- **stage**: `pre`.
- **scope**: `tool:<name>` for each tool that declares a gate.
- **priority**: high (executes early, before plugin transforms that assume the skill is already loaded).
- **mutation semantics**: hard gate aborts the pipeline with a structured error; soft gate aborts with a payload carrying the skill content and adds the skill to `loadedSkills`; passive lets the pipeline continue and injects the skill into the PostToolUse payload.

The transform pipeline is the orchestrator; `skill-gate` is one policy plugged into it. Other PreToolUse policies (permission-check, dry-run, approval-required) can be added in the same model without changing the gate. This composition is normative: implementations of `skill-gate` MUST register through the transform registry, not through ad-hoc hooks in the runtime event loop.

## Failure Modes

- **Skill exists but is unloaded** — both variants behave as designed (reject, or inject + retry).
- **Skill does not exist anywhere** — the runtime MUST surface a clear error: "tool requires skill X, no plugin provides X". This is a configuration error, not a runtime gate failure, and MUST be reported distinctly.
- **Variant 2 mid-flight** — the runtime delivers the skill content; the agent's next attempt is allowed to invoke the tool only after the agent's context has acknowledged the skill. Acknowledgement is a turn boundary, not a free pass.
- **Permission missing** — if the agent lacks permission to load the skill (no `toolgroup:navigate` or skill-specific deny), the gate MUST report the permission gap rather than silently auto-loading.

## Acceptance Criteria

- A tool declared with a hard gate against skill `foo` MUST refuse execution when `foo` is absent from `loadedSkills`, returning a structured error.
- A tool declared with a soft gate MUST return the skill content on the first call and allow the second call to proceed once the skill is in the vector.
- A tool declared with a passive gate MUST execute on the first call AND return the skill content prepended to its output, with the skill added to `loadedSkills` so subsequent calls in the same session do not re-inject.
- Gate failures MUST appear in `ravi events` filtered by event type and carry sufficient context to debug the failure offline.
- Disabling the gate for a tool (operator override) MUST be auditable and MUST NOT happen silently.
