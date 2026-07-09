---
id: quality/failure-modes
title: "Quality Failure Modes"
kind: capability
domain: quality
capability: failure-modes
capabilities:
  - detection
  - classification
  - severity
  - dedupe
tags:
  - quality
  - failure-modes
  - detection
applies_to:
  - src/runtime
  - src/session-trace
  - src/tasks
  - src/insights
owners:
  - ravi-dev
status: draft
normative: true
---

# Quality Failure Modes

## Intent

Failure modes define named classes of bad agent behavior that Ravi can detect, group, and route. They are the contract between raw observations and operational action.

## Failure Mode Shape

Each mode MUST define:

```yaml
id: runtime_stall_missing_terminal_event
title: Runtime stall without terminal event
scope: runtime
severity: high
owner: dev
detect:
  sources:
    - session_trace
    - runtime_events
  predicate: "turn active with no canonical terminal event after provider/tool completion"
evidence:
  include:
    - session_key
    - agent_id
    - turn_id
    - provider
    - last_tool_event
    - adapter_events
    - daemon_log_refs
dedupe:
  key: "mode+provider+boundary+day"
  cooldown: 24h
action:
  default: task
  project: runtime
watch:
  default_window: 24h
  success: "zero recurrences on affected path"
```

## Invariants

- Failure mode ids MUST be stable snake_case identifiers.
- Detection predicates MUST state which sources are authoritative.
- Severity MUST be about operational impact, not emotional salience.
- Dedupe keys MUST prevent one production incident from creating many tasks.
- Modes MUST distinguish evidence from interpretation.
- A mode MAY include heuristic signals, but the confidence field MUST expose that uncertainty.
- Modes MUST NOT require direct user complaint to detect silent failure.

## Canonical Initial Modes

- `runtime_stall_missing_terminal_event`
- `tool_completed_before_confirmation`
- `tool_lifecycle_duplicate_or_out_of_order`
- `agent_ignored_direct_instruction`
- `unauthorized_agent_mutation`
- `user_rephrased_three_times`
- `task_done_without_primary_artifact`
- `cron_blind_repeated`
- `wrong_session_context_bleed`

## Cron Blindness (`cron_blind_repeated`)

Recurring cron failures whose real cause is host resource pressure (disk/temp
exhaustion) are a durable operational failure class, not a per-job flake. When
cron shell jobs fail repeatedly with out-of-space signatures, they MUST be
grouped under one failure mode instead of generating one task per job run.

```yaml
id: cron_blind_repeated
title: Cron jobs repeatedly blind due to host resource pressure
scope: runtime
severity: high
owner: dev
detect:
  sources:
    - cron_job_state
    - runtime_events
  predicate: "recurring cron shell failures whose lastError/notification is classified as disk-pressure (ENOSPC / no space left on device / temp-file creation failure)"
evidence:
  include:
    - cron_job_id
    - last_status
    - last_error
    - disk_pressure_hint
    - doctor_finding_ref  # runtime.disk_space_low
dedupe:
  key: "mode+disk_pressure+day"
  cooldown: 24h
action:
  default: task
  project: runtime
watch:
  default_window: 24h
  success: "runtime.disk_space_low passing and zero disk-pressure cron failures"
```

Classification and remediation stay read-only and approval-gated: detection
links the `runtime.disk_space_low` doctor finding and the disk-pressure hint,
but any cleanup follows the doctor runbook under explicit human approval.

## Promotion Rule

An ad hoc investigation SHOULD become a formal failure mode when it recurs, requires a repeatable investigation path, or is likely to regress.
