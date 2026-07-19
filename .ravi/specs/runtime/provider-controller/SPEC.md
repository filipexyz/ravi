---
id: runtime/provider-controller
title: "Runtime Provider Controller"
kind: capability
domain: runtime
capabilities:
  - provider-controller
  - runtime-target-selection
  - runtime-target-failover
  - credential-inventory
  - fleet-reconciliation
  - delivery-boundary
tags:
  - runtime
  - providers
  - credentials
  - agents
  - resilience
applies_to:
  - src/runtime/session-resolver.ts
  - src/runtime/target-policy-config.ts
  - src/runtime/target-policy.ts
  - src/runtime/runtime-request-builder.ts
  - src/runtime/credential-resolver.ts
  - src/runtime/credential-store.ts
  - src/runtime/host-event-loop.ts
  - src/runtime/provider-registry.ts
  - src/cli/commands/runtime-targets.ts
  - src/cli/commands/runtime-credentials.ts
owners:
  - ravi-dev
status: draft
normative: true
lifecycle: proposed
implementation_status: none
implemented_by:
implemented_at:
implementation_notes:
open_items:
  - Decide CLI surface name after spike: runtime controller vs runtime targets reconcile.
  - Decide whether v2 needs a new resolver source or can remain materialized agent defaults.
decision_makers:
  - ravi-dev
consulted:
  - agent-architect
informed:
  - main
---

# Runtime Provider Controller

## Intent

The Runtime Provider Controller turns Ravi's existing provider primitives into an
operator-visible fleet behavior. It audits agent provider posture, materializes
approved runtime target policies for agents that should have automatic fallback,
and tracks provider access coverage without hiding provider switches inside
adapters.

The controller is not a new model runner. It is a reconciliation layer above
`runtime/target-failover`, `runtime/providers/credential-fallback`, and
`credentials/broker`. Its output is an explicit `RuntimeTargetPolicy` at an
approved scope, plus redacted diagnostics operators can inspect.

## Context / Decision Drivers

Ravi already has provider adapters, credential metadata, and explicit target
failover. The operational gap is that those pieces can exist without being
fleet-applied or observable enough for agents that were expected to fail over
automatically.

The controller exists because:

- installed or authenticated providers are not the same thing as an active
  runtime target policy;
- managed credentials and provider-native auth profiles need one inventory
  surface;
- operators need dry-run/apply/explain commands before changing many agents;
- internal runtime failures must stay inside runtime diagnostics unless a
  sanitized terminal user response is explicitly required;
- future agents need deterministic inheritance rather than manual per-agent
  repair.

## Invariants

- **R1 - Explicit policy materialization.** The controller MUST produce or update
  explicit runtime target policy configuration. It MUST NOT perform hidden
  cross-provider fallback based only on installed tools, env vars, provider
  profile files, or inferred credentials.
- **R2 - Preserve existing target semantics.** Controller output MUST execute
  through the `runtime/target-failover` state machine. Provider adapters still
  execute exactly one resolved target and MUST NOT invent fallback.
- **R3 - KISS first rollout.** The first implementation SHOULD reconcile agent
  defaults using the existing precedence
  `session override > task profile > agent defaults > no failover`. Adding a new
  resolver source such as `controller_default` is a v2 change and requires this
  spec plus SDK/CLI contract updates.
- **R4 - Provider access inventory.** Codex, Pi, Claude, and future providers
  MUST be represented in diagnostics as either managed credential slots,
  provider-native read-only slots, or explicitly untracked legacy auth. A
  provider MUST NOT be reported as controlled merely because it may be usable by
  a subprocess.
- **R5 - Safe same-provider-first recovery.** The controller MUST preserve the
  credential fallback rule: rotate or recover eligible credentials inside the
  selected provider before crossing to the next provider target.
- **R6 - Fleet dry-run before apply.** Any operation that would change multiple
  agents MUST support a dry-run plan showing agents affected, current source,
  proposed target chain, missing access, risk flags, and rollback identifiers.
- **R7 - Minimal mutation.** Apply MUST merge only runtime target policy fields
  or controller-owned defaults. It MUST NOT replace unrelated agent defaults,
  permissions, prompts, channel routing, tools, or task profile settings.
- **R8 - Sanitized external delivery.** Internal frames, raw provider stack
  traces, raw 429/401/402 provider messages, and system command envelopes MUST
  NOT be delivered to customer or business chats as ordinary assistant output.
  They belong in trace/task diagnostics unless explicitly formatted as a
  sanitized terminal response.
- **R9 - Canonical terminality.** Operational provider failures that arrive as
  assistant text plus a terminal-looking completion MUST be reclassified into a
  canonical runtime failure when the text matches a structured operational error
  class. A false success MUST NOT stop configured fallback.
- **R10 - Bounded stuck turns.** A turn with no external output and no active tool
  progress MUST become inspectable and eventually terminal through host
  inactivity policy. The controller cannot leave an agent indefinitely "typing"
  without a runtime status, timeout, or escalation event.
- **R11 - Future-agent inheritance.** A controller-managed default MUST apply to
  newly created agents only through an explicit template, preset, task profile,
  or agent-default materialization path. New agents MUST NOT inherit behavior
  from ambient credentials alone.
- **R12 - Redacted observability.** Controller plan, apply, explain, trace, and
  rollback output MUST contain provider ids, model selectors, policy ids,
  credential ids, redacted fingerprints, and failure classes, never raw secrets
  or provider-native auth file contents.

## Boundaries

In scope:

- fleet audit of agents with and without effective runtime target policies;
- explicit templates for approved provider chains such as Claude -> Codex -> Pi;
- materializing those templates into agent defaults or another approved policy
  scope;
- redacted inventory of managed credentials and provider-native access profiles;
- dry-run/apply/explain/status CLIs and SDK shapes for operators and agents;
- delivery-boundary checks that keep internal runtime frames out of external
  chats;
- regression scenarios proving credential fallback and target fallback compose.

Out of scope:

- a universal provider order hardcoded in core;
- secret storage redesign beyond referencing existing credential abstractions;
- provider-specific fallback branches inside Claude, Codex, Pi, or future
  adapters;
- unsafe replay after tool or side-effect boundaries;
- silently importing every local provider profile as an active credential;
- changing public SDK or DB schema without the normal compatibility review.

## Acceptance Criteria

Every invariant MUST have a row. Without this table the spec MUST NOT be `normative: true`.

| Invariant | Verification Method | Check Ref | Pass Condition |
|-----------|---------------------|-----------|----------------|
| R1 | Inspection | CHECKS.md#C1 | No controller code path switches provider unless an explicit target policy or dry-run/apply result names that target. |
| R2 | Test | CHECKS.md#C2 | Provider adapters still receive one resolved target per attempt and target switching is observed only in the host policy state machine. |
| R3 | Inspection | CHECKS.md#C3 | V1 implementation writes or updates agent-default policy using current precedence, or the spec/SDK is updated before adding a new source. |
| R4 | Demonstration | CHECKS.md#C4 | Status output distinguishes managed slots, provider-native read-only slots, and legacy untracked auth for each controlled provider. |
| R5 | Test | CHECKS.md#C5 | Same-provider credential candidates are exhausted before a cross-provider target switch. |
| R6 | Demonstration | CHECKS.md#C6 | Dry-run shows affected agents, current policy source, proposed policy, missing access, risk flags, and rollback id without mutation. |
| R7 | Test | CHECKS.md#C7 | Applying a controller plan preserves unrelated agent defaults and task profile fields byte-for-byte. |
| R8 | Test | CHECKS.md#C8 | External delivery fixtures containing system envelopes and raw provider errors are blocked or sanitized. |
| R9 | Test | CHECKS.md#C9 | Operational error text emitted as assistant content is normalized to a runtime failure and configured fallback continues. |
| R10 | Demonstration | CHECKS.md#C10 | A no-output/no-progress turn becomes visible in runtime status and reaches timeout/escalation according to policy. |
| R11 | Demonstration | CHECKS.md#C11 | A newly created agent receives controller behavior only through an explicit template/preset/profile/default materialization path. |
| R12 | Inspection | CHECKS.md#C12 | Plan, apply, explain, trace, and rollback outputs redact secrets and provider-native auth contents. |

Verification Method is one of: `Test` | `Demonstration` | `Inspection` | `Analysis`.

## Adaptation

Open adaptation decisions:

- `CLI surface`: The spike must choose between `ravi runtime controller ...` and
  extending `ravi runtime targets ...`. Until then, docs may use
  `runtime controller` as the conceptual name.
- `Policy storage`: The implementation should first verify whether the existing
  `runtime_target_policies` table is live or abandoned. If live, reuse it for
  controller templates. If abandoned, either revive it with tests or store the
  template through the existing settings/presets path.
- `Resolver source`: V1 should avoid a new resolver source. If v2 adds
  `controller_default`, it must update `RuntimeTargetPolicySource`, SDK schemas,
  `runtime targets explain`, and all precedence docs.

Any additional decision this spec cannot resolve up-front MUST take one of
these paths (never a bare TBD):

- (a) become a spike sub-task with its own acceptance criteria before implementation dispatch; or
- (b) declare `resolution_deadline: <date>` + `blocking_for: [Rk, ...]`; or
- (c) be reported back as an explicit update to this spec before `done`.

## Known Failure Modes

- Agent has authenticated Codex or Pi locally, but no explicit target policy
  includes those providers, so no cross-provider fallback occurs.
- A Claude credential pool rotates from an exhausted credential to a disabled
  credential, then reports the disabled state as assistant success and prevents
  Codex/Pi fallback.
- Provider-native auth exists, but it is invisible to runtime credential status,
  so operators cannot tell whether a fallback target is actually usable.
- A mass update replaces unrelated agent defaults while trying to add a runtime
  target policy.
- Raw system command envelopes or provider errors are emitted into a business
  chat because delivery treats every assistant message as user-facing content.
- A runtime process accepts a prompt and keeps an external typing indicator
  active without progress telemetry or a timeout.
- A future agent is created after the rollout and misses the fallback policy
  because the fix only patched existing agents.
- A provider adapter implements local fallback, bypassing the host state machine
  and making trace/replay impossible to audit.

## Governance

- `decision_makers`: ravi-dev
- `consulted`: agent-architect for resolver precedence, auditor for mass-apply
  gates, main for user-facing delivery policy.
- `informed`: operators of agents whose defaults are reconciled.

## Changelog

- 2026-07-17: Initial proposed controller spec and PRD.
