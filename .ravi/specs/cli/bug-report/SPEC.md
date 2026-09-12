---
id: cli/bug-report
title: "Global bug-report agent-first CLI contract"
kind: capability
domain: cli
capabilities:
  - bug-report
tags:
  - cli
  - bug-report
  - agent-first
  - error-envelope
  - exit-taxonomy
  - write-brake
  - console
applies_to:
  - src/cli/commands/bug.ts
  - src/cli/agent-contract.ts
  - src/bug-report/client.ts
  - src/bug-report/schema.ts
  - src/bug-report/prompt.ts
  - src/prompt-builder.ts
owners:
  - ravi-dev
status: active
normative: true
---
# Global bug-report agent-first CLI contract

## Intent

Make `ravi bug` the dedicated, **global** (not org-scoped) path for filing
product/runtime bugs to Ravi Console. The command uses `ravi login` cloud
credentials. Organization and project refs are optional dossier fields only;
they MUST NOT scope the CLI group or the Console client path.

`ravi feedback` remains the general feedback inbox. Product/runtime bugs MUST
go through `ravi bug report` and `POST /api/cli/bugs`, not `/api/cli/feedback`.

The happy path is agent-first and two-step:

1. Without `--execute`, do **not** POST. Print/inject a collection prompt that
   forces the agent to gather evidence, sanitize secrets, and fill schema
   `ravi.bug_report/v1`. Exit with the write brake (`WRITE_REQUIRES_EXECUTE`,
   exit `3` + plan), consistent with `ravi feedback send`.
2. With `--execute` and a valid dossier, POST to Console `POST /api/cli/bugs`
   and print the bug id plus a tracking URL.

Read ops `bug status <id>` and `bug list` return the caller's own reports.

## Schema (`ravi.bug_report/v1`)

```ts
{
  schemaVersion: "ravi.bug_report/v1",
  title: string,
  summary: string,
  severity: "low" | "medium" | "high" | "critical",
  surface?: string,
  reproduction?: { steps?: string[]; expected?: string; actual?: string; frequency?: string },
  environment?: { raviVersion?: string; os?: string; runtime?: string; agentNames?: string[] },
  evidence?: { logs?: string[]; notes?: string[]; redactions?: string[] },
  context?: { organizationRef?: string; projectRef?: string; sessionHints?: string },
  sanitization?: { rulesApplied?: string[] }
}
```

`title`, `summary`, and `severity` are required on `--execute` and on any
supplied `--dossier-json` / `--dossier-file`. Flag-only dry-runs MAY be
partial so the first call can be `ravi bug report` with no dossier.

## Invariants

1. `bug report` (alias `create`) MUST default to dry-run and require
   `--execute`. The dry-run MUST report `dryRun: true` and a
   content-minimized plan that includes `schemaVersion`, presence/length/count
   summaries, normalized `severity`/`surface` when known, and the collection
   prompt. It MUST NOT read credentials nor perform any network call.
2. The brake MUST fire BEFORE authentication. A dry-run works without stored
   credentials and leaks nothing off the machine.
3. Raw title, summary, reproduction text, evidence bodies, organization /
   project refs, session hints, and Console override MUST NOT appear in the
   plan. `surface` MAY remain as the product surface selector.
4. Payload validation MUST fail fast even in dry-run when the supplied
   dossier or flag is unsendable: invalid `--severity`, broken
   `--dossier-json` / `--dossier-file`, conflicting dossier sources, or an
   `--execute` without a complete dossier. These exit with
   `PAYLOAD_INVALID` (process exit `2` after the cloud-error contract map),
   never as the write-brake exit `3`.
5. A thrown `ContractError` (the brake) MUST NOT be wrapped by the
   CloudAuthError mapper — it bubbles to the dispatcher preserving exit 3.
6. `--execute` MUST POST the validated dossier to `/api/cli/bugs` with
   `source: "cli"` and print `id` + tracking URL. The client path is stable
   even if the sibling Console PR lands later.
7. `bug status <id>` MUST GET `/api/cli/bugs/<id>`. `bug list` MUST GET
   `/api/cli/bugs` (the authenticated user's reports), expose `--json`,
   `--limit`, `--offset`, and `--fields`, and paginate for agents.
8. Existing cloud error semantics stay: `AUTH_REQUIRED` / `AUTH_EXPIRED`
   teach `ravi login`. Reads and `--execute` require login; dry-run MUST NOT.
9. Sessions MUST carry a short always-on prompt: if the session finds a
   product/runtime bug, ask the user whether to file a Ravi bug report; if
   yes, use `ravi bug report` (collect/sanitize first; only `--execute`
   after the dossier is ready). Do not spam. Do not submit without
   confirmation. Do not replace `ravi feedback`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| report (alias create) | publishes externally to Ravi Console; not retractable via CLI | dry-run + `--execute` |
| status | read of the caller's own report | none |
| list | read of the caller's own reports | none |

## Official error cases

| case | code | exit |
|---|---|---|
| braked report without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid / incomplete dossier | `PAYLOAD_INVALID` | 2 |
| missing/expired credentials on execute or reads | `AUTH_REQUIRED` / `AUTH_EXPIRED` | 1 |

## Console API assumption

The CLI client path is:

- `POST /api/cli/bugs` — create; body is the dossier + `source`
- `GET /api/cli/bugs` — list the authenticated user's reports
- `GET /api/cli/bugs/:id` — show one report

Tracking URL preference: response `url` or `trackingUrl`, else
`<consoleUrl>/bugs/<id>`. A sibling `ravi-console` PR may land the HTTP
handlers; this repo MUST keep the client path stable.

## Internal consumers

The default runtime system prompt (`src/prompt-builder.ts`, section
`bug.report`) teaches the ask-then-`ravi bug report` flow. `--help` on
`bug report` is the SSoT for dossier shape, sanitization, and the brake.

## Validation

- `bun test src/cli/commands/bug.test.ts` green (contract block included).
- `bun test src/prompt-builder.test.ts` green (session prompt present).
- Live checks: `ravi bug report --json` → exit 3 + plan + collection prompt,
  no network; `ravi bug report --dossier-json '<valid>' --execute --json` →
  submits (requires login); `--severity bogus` → `PAYLOAD_INVALID` even
  without `--execute`.

## Known Failure Modes

- `runBugCommand` wraps unknown errors as `SERVER_UNAVAILABLE`; without the
  explicit `ContractError` rethrow the brake would be swallowed into a
  cloud-error envelope with the wrong exit code.
- Putting auth before the brake would make dry-run require `ravi login` and
  regress the agent-first collect step.
- Routing bugs through `ravi feedback send --kind bug` would split the
  Console inbox and skip the dossier/sanitization contract.
