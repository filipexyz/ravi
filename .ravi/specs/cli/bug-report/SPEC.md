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
  - src/bug-report/follow.ts
  - src/bug-report/schema.ts
  - src/bug-report/sanitize.ts
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
   and print the bug id plus a tracking URL. Then auto-follow that bug:
   subscribe this installation and arm a per-bugId trigger into the current
   session. Follow failures MUST NOT fail the create that already succeeded.

Read ops `bug status <id>` and `bug list` return the caller's own reports.

Follow-up diagnosis after the original filing MUST append to the same id
with `bug comment <id>` (alias `append`). Do not file a second report.

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

## Schema (`ravi.bug_comment/v1`)

```ts
{
  schemaVersion: "ravi.bug_comment/v1",
  text?: string,
  evidence?: { logs?: string[]; notes?: string[]; redactions?: string[] },
  sanitization?: { rulesApplied?: string[] }
}
```

`--execute` on `bug comment` requires an existing bug id plus at least
`text` or evidence `logs`/`notes`. The CLI sanitizes tokens, cookies,
private keys, and common secret assignments before the brake plan and
before POST, and records what it redacted. `--evidence-file` MAY be
plain text (one note), a JSON evidence object, or a comment dossier.
A create dossier (`ravi.bug_report/v1`) MUST be rejected.

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
6. `--execute` MUST POST a Console `createBodySchema` body to
   `/api/cli/bugs`: top-level `{schemaVersion, title, summary, severity,
   surface?}` plus required `payload` (the full dossier, with `source`
   inside `payload` only). `organizationId` / `projectId` MUST be sent
   only when dossier `context` refs parse as UUIDs; slugs MUST NOT be
   sent as those fields. Then print `id` + tracking URL.
7. After a successful `--execute` create, the CLI MUST auto-follow that bug
   as a post-create hook (warn-only; create stays successful):
   - `POST /api/cli/bugs/:id/subscribe` with the current cloud-auth
     `installationId` so Console push-delivers `watch.console.bug.status`
     only to subscribers of that bugId.
   - Ensure a `ravi triggers` record exists that fires into the **current
     session** (`session: main`, `replySession` from the caller context)
     on topic `ravi.watch.console.bug.status` (Console delivery
     `watch.console.bug.status` → local `ravi.watch.<connector>.<event>`).
   - The trigger filter MUST include only this bugId:
     `data.payload.bugId == "<id>" || data.bugId == "<id>"`.
     Other bugIds MUST NOT match. Do not create a broad "all my bugs"
     trigger. Cooldown is 30s. Message is short: status + title +
     consoleUrl.
   - Reuse an existing `bug-follow:<id>` trigger when present.
8. `bug status <id>` MUST GET `/api/cli/bugs/<id>`. `bug list` MUST GET
   `/api/cli/bugs` (the authenticated user's reports), expose `--json`,
   `--limit`, `--offset`, and `--fields`, and paginate for agents.
9. Existing cloud error semantics stay: `AUTH_REQUIRED` / `AUTH_EXPIRED`
   teach `ravi login`. Reads and `--execute` require login; dry-run MUST NOT.
10. Sessions MUST carry a short always-on prompt: if the session finds a
   product/runtime bug, ask the user whether to file a Ravi bug report; if
   yes, use `ravi bug report` (collect/sanitize first; only `--execute`
   after the dossier is ready). If more evidence arrives after a report
   already exists, use `ravi bug comment <id>` on that same id. Do not
   spam. Do not submit without confirmation. Do not replace `ravi feedback`.
   Do not file a second report for follow-up diagnosis.
11. `bug comment <id>` (alias `append`) MUST default to dry-run and require
    `--execute`. The dry-run MUST report `dryRun: true` and a
    content-minimized plan (`schemaVersion`, presence/length/count
    summaries, collection prompt). It MUST NOT read credentials nor
    perform any network call. Raw `--text`, evidence bodies, file
    contents, and Console override MUST NOT appear in the plan.
12. `--execute` on `bug comment` MUST POST Console `commentBodySchema` to
    `/api/cli/bugs/<id>/comments`: top-level `{schemaVersion, text?,
    idempotencyKey}` plus required `payload` (the sanitized comment, with
    `source` inside `payload` only). It MUST also send `Idempotency-Key`.
    The default key is `sha256:` plus the hex digest of this bug id and
    the sanitized `text`/`logs`/`notes`. An explicit `--idempotency-key`
    overrides it. Retries with the same key MUST NOT create a duplicate
    comment; Console is the idempotency ledger (`reused: true` on replay).
    The CLI does not keep a local comment log.
13. `bug comment` MUST NOT change title, severity, priority, or status.
    It is append-only. The HITL / `--execute` barrier MUST stay as
    strong as `bug report`.

## Write classification (brake decision per op)

| op | class | brake |
|---|---|---|
| report (alias create) | publishes externally to Ravi Console; not retractable via CLI | dry-run + `--execute` |
| comment (alias append) | publishes a follow-up onto an existing Console bug; not retractable via CLI | dry-run + `--execute` |
| status | read of the caller's own report | none |
| list | read of the caller's own reports | none |

## Official error cases

| case | code | exit |
|---|---|---|
| braked report or comment without `--execute` | `WRITE_REQUIRES_EXECUTE` + plan | 3 |
| invalid / incomplete dossier or follow-up | `PAYLOAD_INVALID` | 2 |
| missing/expired credentials on execute or reads | `AUTH_REQUIRED` / `AUTH_EXPIRED` | 1 |

## Console API assumption

The CLI client path is:

- `POST /api/cli/bugs` — create; body is Console `createBodySchema`
  (`title`, `summary`, `severity`, required `payload`, optional
  `schemaVersion` / `surface` / UUID `organizationId` / `projectId`)
- `GET /api/cli/bugs` — list the authenticated user's reports
- `GET /api/cli/bugs/:id` — show one report
- `POST /api/cli/bugs/:id/subscribe` — follow this bug from the current
  CLI installation. Body is `{ installationId }` from stored cloud-auth
  credentials. Console MUST push `watch.console.bug.status` only to
  subscribers of that bugId. After the local delivery bridge the NATS
  subject is `ravi.watch.console.bug.status` (catalog family
  `ravi.watch.*.*` / `ravi.watch.>`). Expected payload fields for the
  per-bug filter: `payload.bugId` on the normalized watch event, or
  flattened `bugId`.
- `POST /api/cli/bugs/:id/comments` — append a sanitized follow-up.
  Body is Console `commentBodySchema` (`schemaVersion`, optional `text`,
  required `payload`, required `idempotencyKey`). Header `Idempotency-Key`
  repeats that key. Console MUST treat the same caller + bug id + key as
  a replay and return the original comment with `reused: true` instead of
  inserting a duplicate. A 404 on this path means Console has not deployed
  the append API yet; keep the id and do not file a second report.

Tracking URL preference: response `url` or `trackingUrl`, else
`<consoleUrl>/bugs/<id>`. A sibling `ravi-console` PR may land the HTTP
handlers; this repo MUST keep the client path constants stable
(`BUG_REPORT_API_PATH`, `bugReportSubscribeApiPath`,
`bugReportCommentApiPath`). Production Console (2026-09-22) served
create/status/list/subscribe but returned HTML 404 for `/comments`.
A sibling `ravi-console` PR should land `POST /api/cli/bugs/:id/comments`.

## Internal consumers

The default runtime system prompt (`src/prompt-builder.ts`, section
`bug.report`) teaches the ask-then-`ravi bug report` flow and the
append-to-same-id `ravi bug comment <id>` path. `--help` on
`bug report` / `bug comment` is the SSoT for dossier shape, sanitization,
and the brake.

## Validation

- `bun test src/cli/commands/bug.test.ts` green (contract block included).
- `bun test src/bug-report/client.test.ts` green (create + comment mappers).
- `bun test src/bug-report/sanitize.test.ts` green (token/key redaction).
- `bun test src/bug-report/follow.test.ts` green (per-bugId filter scope).
- `bun test src/prompt-builder.test.ts` green (session prompt present, including comment).
- Live checks: `ravi bug report --json` → exit 3 + plan + collection prompt,
  no network; `ravi bug report --dossier-json '<valid>' --execute --json` →
  submits (requires login); `--severity bogus` → `PAYLOAD_INVALID` even
  without `--execute`. `ravi bug comment <id> --json` → exit 3 + plan;
  `ravi bug comment <id> --text '…' --execute --json` → appends (requires
  login and the Console comment route).

## Known Failure Modes

- `runBugCommand` wraps unknown errors as `SERVER_UNAVAILABLE`; without the
  explicit `ContractError` rethrow the brake would be swallowed into a
  cloud-error envelope with the wrong exit code.
- Putting auth before the brake would make dry-run require `ravi login` and
  regress the agent-first collect step.
- Routing bugs through `ravi feedback send --kind bug` would split the
  Console inbox and skip the dossier/sanitization contract.
- A broad `ravi.watch.console.bug.*` trigger without a per-bugId filter
  would wake this session for other sessions' bugs. The post-create hook
  MUST keep the filter scoped to the created id.
- Throwing from the subscribe/trigger hook would fail a create that
  already succeeded. Follow is warn-only.
