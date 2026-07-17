---
id: runtime/provider-controller/prd
title: "PRD: Runtime Provider Controller"
status: proposed
owner: ravi-dev
related_specs:
  - runtime/provider-controller
  - runtime/target-failover
  - runtime/providers/credential-fallback
  - runtime/providers
  - credentials/broker
---

# PRD: Runtime Provider Controller

## Summary

Ravi needs a small, explicit controller that turns provider and credential
configuration into reliable fleet behavior. The controller audits agents,
builds a dry-run plan, and materializes approved runtime target policies so
agents can move from Claude to Codex to Pi when configured failure conditions
are met.

The product goal is not "try whatever credential exists". The goal is
operator-visible automatic provider control: every agent has an explainable
effective policy, every provider access path appears in diagnostics, and every
user-facing response is separated from internal runtime failures.

## Problem

The current runtime has the right primitives, but they are not enough as a
product surface:

- Runtime target failover is explicit and opt-in. Agents without an effective
  target policy keep single-provider behavior even when other providers are
  authenticated.
- Managed credential status may show Claude slots while Codex/Pi remain
  provider-native and therefore operationally invisible or ambiguous.
- Operators lack one command that answers: "which agents will fail over, to
  what, using which access, and why?"
- Provider errors can arrive in shapes that look like assistant output. If that
  is treated as success, fallback stops early.
- Internal system envelopes and raw provider errors can leak into external
  chats when delivery does not distinguish runtime diagnostics from user
  messages.
- Long-running turns can appear stuck without a clear status, timeout, or
  operator action.

## Users

- Operators configuring provider behavior across many agents.
- Agent maintainers who need a safe default for newly created agents.
- Runtime developers debugging provider, credential, and delivery failures.
- Business users who should receive concise terminal responses, not raw runtime
  internals.

## Goals

- Provide a fleet-level provider controller with dry-run, apply, explain,
  status, and rollback-oriented diagnostics.
- Keep fallback explicit by materializing `RuntimeTargetPolicy` data through
  existing target policy machinery.
- Show provider access coverage for managed credentials and provider-native
  auth profiles in one redacted inventory.
- Reconcile existing agents and define how future agents inherit controller
  templates.
- Preserve same-provider credential fallback before cross-provider target
  fallback.
- Prevent internal frames and raw provider errors from being delivered as normal
  assistant output.
- Make no-output/no-progress turns observable and bounded.

## Non-goals

- Hardcoding one universal provider order in core.
- Discovering local credentials and silently making them active fallback
  providers.
- Moving fallback logic into Claude, Codex, Pi, or any future provider adapter.
- Redesigning secret storage as part of the controller MVP.
- Replaying after unsafe tool or side-effect boundaries.
- Changing public SDK or DB schema in the KISS rollout unless the spike proves
  the current surfaces cannot express the behavior.

## Proposed Improvements

1. Add a controller plan/apply/explain/status surface.
   The first version may live under `ravi runtime targets reconcile` or a new
   `ravi runtime controller` group, but it must expose dry-run before apply.

2. Introduce provider-chain templates.
   Templates describe approved target chains such as Claude -> Codex -> Pi,
   with model selectors, required capabilities, credential requirements, and
   replay safety options. Secrets never enter templates.

3. Reconcile agents without effective policies.
   V1 should materialize the selected template into agent defaults so current
   precedence remains unchanged: session override, task profile, agent defaults,
   no failover.

4. Define future-agent inheritance.
   New agents should receive controller behavior only through an explicit
   default template, preset, task profile, or agent-default materialization path.

5. Make provider-native access visible.
   Codex/Pi/Claude provider-native profiles should appear as read-only
   credential slots or as explicit "legacy untracked" diagnostics. Operators
   must be able to tell whether a fallback target is controlled.

6. Add a fleet audit view.
   The status command should count agents by provider, policy source, missing
   policy, missing provider access, disabled credential, exhausted credential,
   and unsafe configuration.

7. Normalize operational provider failures.
   Provider output that carries auth, quota, disabled subscription, billing, or
   rate-limit errors must become canonical runtime failure, even if it arrived
   as assistant text.

8. Keep delivery boundaries explicit.
   System envelopes, command execution frames, raw provider errors, stack
   traces, and internal task diagnostics should not be emitted to external
   chats as ordinary assistant output.

9. Add no-output watchdog diagnostics.
   A turn that accepts work but produces no assistant output or tool progress
   should expose status and terminate or escalate according to runtime policy.

10. Add regression scenarios for all fallback paths.
    Tests must cover same-provider rotation, cross-provider target switching,
    all-target exhaustion, unsafe replay block, delivery sanitization, and stuck
    turn handling.

11. Reuse or retire existing policy storage.
    If `runtime_target_policies` is intended to store policy templates, wire it
    with tests and CLI. If not, document it as unused and avoid building new
    behavior on a dead table.

12. Extend SDK only when needed.
    V1 can avoid a new resolver source by writing agent defaults. If v2 adds
    `controller_default`, SDK schemas and `runtime targets explain` must change
    together.

## Reference Alignment: Provider Cascade Draft

A broader "Provider Cascade" draft exists as useful input, but it must be
adapted to Ravi's current runtime architecture before implementation. The draft
correctly identifies the product need: provider fallback must be automatic,
observable, and safe under quota, auth, billing, rate-limit, and provider outage
failures.

Material to keep:

- canonical failure taxonomy for quota, rate limit, provider down, auth,
  context overflow, permission denied, timeout, and unknown errors;
- same-provider retry/credential recovery before cross-provider failover;
- health/cooldown/probe concepts, if implemented through existing runtime health
  and target policy state rather than a parallel provider system;
- redacted event/trace diagnostics for failover, exhaustion, recovery, and
  manual intervention;
- explicit no-raw-error delivery boundary for external chats;
- eval or smoke gate before a fallback model becomes production eligible;
- pre-mortem/FMEA framing as checklist input for rollout risk.

Material to reject or defer:

- A new `src/providers` subsystem that bypasses `RuntimeProvider`,
  `runtime/target-failover`, `runtime/providers/credential-fallback`, or the
  current request builder.
- A new public `ravi providers ...` surface as v1 if the same behavior fits
  under `ravi runtime targets ...`, `ravi runtime credentials ...`, and a small
  controller/reconcile command.
- New tables such as `providers`, `agent_provider_chains`, and
  `provider_health` before verifying the existing runtime credential and target
  policy storage.
- Treating provider events as a command bus or adding new NATS event formats
  without the normal event-contract review.
- Mid-turn replay/failover promises that conflict with existing unsafe
  side-effect boundaries.
- Cross-vendor handoff defaults that are implicit. Cross-provider behavior must
  be visible in the policy chain and access diagnostics.
- Automatic pending-prompt replay as v1 product behavior. Queue/replay must
  reuse the existing runtime delivery queue semantics or be explicitly specified
  before implementation.

The implementation path remains: reuse current runtime primitives first, add
only the smallest controller layer needed to make provider policy fleet-wide and
auditable.

## User Stories

- As an operator, I can run a dry-run and see which agents lack provider
  fallback before applying changes.
- As an operator, I can apply a provider-chain template to selected agents
  without changing unrelated defaults.
- As an agent maintainer, I can explain why an agent selected Claude, Codex,
  Pi, or no fallback for a turn.
- As a runtime developer, I can see whether a provider failed because of a
  credential, provider health, model selector, capability mismatch, or delivery
  boundary.
- As a business user, I receive a clear terminal response when all providers are
  unavailable, not a raw internal frame.

## Functional Requirements

- The plan command must support selection by agent id, provider, policy source,
  missing policy, and dry-run all.
- The plan output must include current effective source, proposed policy,
  target order, missing provider access, disabled/exhausted credentials, replay
  risk flags, and rollback id.
- The apply command must require a previously generated plan id or reproduce the
  same plan deterministically before writing.
- Apply must merge only runtime target policy fields or controller-owned
  defaults.
- Explain must show whether behavior came from session override, task profile,
  agent defaults, controller materialization, or no failover.
- Status must summarize fleet posture and provider access coverage without
  secrets.
- Controller templates must be versioned and hashable.
- Credential inventory must distinguish managed slots, provider-native
  read-only slots, and legacy untracked auth.
- Runtime failure classification must convert operational provider errors into
  canonical failure classes before target success is committed.
- Delivery must block or sanitize internal-only frames before external channel
  emission.

## Rollout

### Phase 0 - Spike and inventory

- Verify live use of `runtime_target_policies`.
- Confirm SDK and registry surfaces for runtime targets and credentials.
- Build read-only audit output from existing data.

### Phase 1 - KISS reconciliation

- Add dry-run/apply that writes explicit agent-default runtime target policies.
- Keep current resolver precedence unchanged.
- Add tests proving unrelated defaults are preserved.
- Add fleet audit and controller explain diagnostics.

### Phase 2 - Access inventory hardening

- Represent Codex/Pi/Claude provider-native profiles as read-only slots or
  explicit legacy diagnostics.
- Add health and redacted fingerprint visibility for provider-native access.

### Phase 3 - Delivery and terminality hardening

- Add sanitizer tests for internal frames and raw provider errors.
- Add watchdog/status handling for no-output/no-progress turns.

### Phase 4 - Optional resolver source

- Only if Phase 1 is too limited, add `controller_default` as a new
  `RuntimeTargetPolicySource` and update SDK/CLI/specs atomically.

## Success Metrics

- Every controlled agent has an explainable effective target policy.
- Dry-run can report all agents with missing or unsafe provider controller
  posture before any mutation.
- A configured chain advances Claude -> Codex -> Pi when failures are eligible
  and replay is safe.
- Disabled/exhausted credentials do not produce false runtime success.
- External chats do not receive system envelopes or raw provider error frames.
- Stuck turns become visible and terminal according to policy.

## Risks

- Mass policy apply could change too many agents if selection filters are weak.
- Provider-native access may be hard to fingerprint without reading sensitive
  content.
- Adding a new resolver source too early would widen SDK and compatibility
  blast radius.
- Sanitizing delivery too aggressively could hide useful terminal errors from
  operators unless trace links remain available.

## Open Questions

- Should the public CLI be `runtime controller` or an extension of
  `runtime targets`?
- Is `runtime_target_policies` live storage, abandoned storage, or the intended
  template store?
- Which provider-native profile metadata is safe and stable enough for Codex and
  Pi read-only slots?
- Which channels need stricter delivery sanitization by default?
