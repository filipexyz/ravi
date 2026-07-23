---
id: doctor/output
title: "Doctor Output"
kind: capability
domain: doctor
capability: output
tags:
  - doctor
  - output
  - json
  - cli
  - sdk
applies_to:
  - src/cli/commands/doctor.ts
  - src/cli/decorators.ts
  - src/sdk/openapi
owners:
  - dev
status: draft
normative: true
---

# Doctor Output

Status: draft
Owner: dev
Last updated: 2026-06-08

## Intent

Doctor output MUST be useful to humans, agents, CI, and future repair
automation. The JSON contract is the source of truth; human output is a
projection of it.

## JSON Contract

`ravi doctor --json` MUST return an object with these top-level fields:

```ts
type DoctorReport = {
  generatedAt: string;
  ok: boolean;
  summary: DoctorSummary;
  runtime: DoctorRuntimeSnapshot;
  findings: DoctorFinding[];
  checks: DoctorCheckResult[];
};
```

`ok` MUST be `true` only when there are zero `error` findings.

## Summary

```ts
type DoctorSummary = {
  errors: number;
  warnings: number;
  infos: number;
  checks: {
    total: number;
    passed: number;
    failed: number;
    skipped: number;
  };
  domains: Record<
    string,
    {
      errors: number;
      warnings: number;
      infos: number;
      totalChecks: number;
      failedChecks: number;
      skippedChecks: number;
    }
  >;
};
```

## Runtime Snapshot

```ts
type DoctorRuntimeSnapshot = {
  version?: string;
  branch?: string;
  commit?: string;
  dirty?: boolean;
  cwd?: string;
  daemon?: {
    online?: boolean;
    version?: string;
    pid?: number;
    memoryMb?: number;
    cpuPercent?: number;
  };
  database?: {
    path?: string;
    schemaVersion?: string;
    migrationsKnown?: boolean;
  };
};
```

Runtime fields MAY be omitted when unavailable. They MUST NOT contain secrets.

## Findings

```ts
type DoctorSeverity = "error" | "warn" | "info";

type DoctorFinding = {
  id: string;
  severity: DoctorSeverity;
  domain: string;
  title: string;
  summary: string;
  evidence: DoctorEvidence[];
  fixHint?: string;
  data?: Record<string, unknown>;
};

type DoctorEvidence = {
  label: string;
  value?: string | number | boolean | null;
  entity?: {
    type: string;
    id?: string;
    name?: string;
  };
  source?: string;
};
```

Finding ids MUST be stable and machine-readable, for example
`routes.agent_missing` or `costs.pricing_unpriced_usage`.

Evidence MUST be concise. Large payloads SHOULD be summarized and linked to a
read command or entity id.

`fixHint` SHOULD be a safe next step, not an automatic mutation.

## Checks

```ts
type DoctorCheckStatus = "pass" | "fail" | "skip";

type DoctorCheckResult = {
  id: string;
  domain: string;
  title: string;
  status: DoctorCheckStatus;
  severity: DoctorSeverity;
  findings: string[];
  durationMs: number;
  data?: Record<string, unknown>;
};
```

`findings` MUST contain finding ids emitted by that check. Passing checks MAY
have an empty `findings` list.

Skipped checks MUST include `data.reason` or an `info` finding explaining why
the check could not run.

## Human Output

Default human output SHOULD be compact:

```text
ravi doctor: 2 error, 4 warn, 9 info

ERROR
- routes.agent_missing: Route points to missing agent ravi-namastex

WARN
- permissions.command_mutation_unclassified: 94 open-scope commands look mutating

INFO
- permissions.provider_runtime_default_chain: default provider chain matches contract
- permissions.local_operator_explicit: missing-principal authorization fails closed
- permissions.runtime_bootstrap_scope: runtime bootstrap excludes actor/surface/admin authority
- sdk.returns: 561 public commands, 0 missing returns
```

`--full` SHOULD include:

- runtime snapshot;
- all findings;
- skipped checks;
- domain summaries.

The human output MUST NOT require Markdown tables.

## Exit Codes

Default mode:

- exit `0` when `summary.errors === 0`;
- exit `1` when `summary.errors > 0`;
- exit `2` when doctor itself fails before producing a valid report.

Strict mode:

- exit `0` when there are no errors and no warnings;
- exit `1` when there are errors;
- exit `3` when there are warnings but no errors;
- exit `2` when doctor itself fails before producing a valid report.

## SDK And OpenAPI

If `ravi doctor` is public in the CLI registry, it MUST declare a typed return
schema for `DoctorReport`.

The SDK/OpenAPI projection MUST expose the same shape and MUST NOT collapse
the return to generic JSON.
