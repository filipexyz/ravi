---
id: storage
title: "Storage"
kind: domain
domain: storage
capabilities:
  - cleanup
  - report
  - summary
  - schedule
tags:
  - storage
  - cleanup
  - disk
  - safety
  - receipts
applies_to:
  - src/cli/commands/storage.ts
  - src/cli/commands/storage.test.ts
  - src/storage/policy.ts
  - src/storage/eligibility.ts
  - src/storage/cleanup.ts
  - src/storage/types.ts
  - src/storage/fsutil.ts
  - src/storage/disk.ts
  - src/storage/format.ts
  - src/storage/backups.ts
  - src/storage/attachments.ts
  - src/storage/claude-jsonl.ts
  - src/storage/omni-broadcast.ts
  - src/storage/omni-probe.ts
  - src/storage/report.ts
  - src/storage/summary.ts
  - src/storage/notify.ts
  - src/storage/schedule.ts
  - src/storage/receipts.ts
  - src/storage/storage.test.ts
  - src/storage/storage-v2.test.ts
owners:
  - ravi-dev
status: draft
normative: true
---

# Storage

## Intent

`storage` owns the single native, deterministic, fail-closed, human-readable and
machine-readable disk-cleanup operation for the Ravi host. It replaces the shell
`ravi-disk-janitor.sh` heuristic with a governed process that never trades
disk for state: ambiguity always preserves data.

This domain is the semantic owner above:

- task lifecycle and worktree removal (see `tasks`);
- Codex session artifacts (provider runtime state);
- Omni holds and references (see `omni` surfaces);
- Ravi runtime temp namespaces;
- the cleanup receipt ledger.

It MUST NOT redefine those systems. It only *reads* their state to decide
eligibility and *asks their canonical primitive* to act where one exists.

## Boundary

`storage` owns:

- four read/write command surfaces on the same policy:
  - `ravi storage cleanup --tier <routine|weekly> [--notify <session>] [--execute] [--json]`;
  - `ravi storage report [--json]` (read-only bytes per class: eligible vs in doubt);
  - `ravi storage summary [--since <window>] [--json]` (read-only receipt aggregation);
  - `ravi storage schedule [--execute] [--json]` (idempotent weekly cron);
- a fixed, versioned policy (allowlists, age thresholds, protected paths) as the
  single source of truth;
- eligibility decisions and fail-closed ambiguity handling;
- the human summary (space before / after / freed, areas cleaned, preserved, errors);
- the compact receipt with bounded retention.

`storage` does NOT own and MUST NOT implement:

- separate `status`, `plan` or `policy` commands (the tier selection *is* the plan;
  `report` is read-only accounting, not a planner);
- dashboards, 6-hour monitors, monthly backups or MCP surfaces;
- a generic cleanup framework beyond these four operations;
- the cron engine (owned by `cron`): `schedule` only creates/updates the one
  canonical job through the cron store;
- installing, restarting, deploying or deleting real host data during tests.

Scope note (KISS v2): `cleanup` remains the only mutating cleanup operation. The
three additions are read-only views (`report`, `summary`) and the idempotent
registration of the weekly job (`schedule`); they do not add a generic framework.

## Definitions

- `tier`: the fixed policy preset. `routine` = high-frequency, low-risk; `weekly`
  = lower-frequency, higher-consequence. Exactly two accepted values.
- `policy`: the compiled, versioned set of allowlists, age thresholds, protected
  roots and receipt rules owned by this domain. Identified by
  `STORAGE_POLICY_VERSION` plus a stable content hash.
- `candidate`: a filesystem entry that the policy classifies as eligible, before
  the deletion gate.
- `executed`: a candidate actually removed. Only reachable with `--execute`.
- `receipt`: the compact JSON record of one run, written to the policy-defined
  receipt path.
- `hold`: an Omni-managed marker stating an object MUST be preserved.
- `reference`: an Omni-managed link from a live object to a filesystem object.
- `fail-closed`: on any missing, stale, contradictory or unreachable signal, the
  entry is preserved and the run continues; the run never guesses.

## CLI Surface

The public surface is the `storage` group with exactly these four operations:

```
ravi storage cleanup  --tier <routine|weekly> [--notify <session>] [--execute] [--json]
ravi storage report   [--json]
ravi storage summary  [--since <window>] [--json]
ravi storage schedule [--execute] [--json]
```

- The group is `storage`. No operation outside this list MUST exist.
- `cleanup` is the only operation that removes bytes.
- `--tier` is REQUIRED for `cleanup` and MUST accept exactly `routine` and `weekly`.
- Dry-run is the default for `cleanup` and `schedule`. Mutation MUST require the
  explicit `--execute` flag; `schedule` without it exits `3` with the plan.
- `report` and `summary` MUST be read-only: no receipt, no lock, no directory.
- `cleanup --notify <session>` MUST require `--execute` and reports the last 7 days.
- `--json` MUST return one machine-readable result; without it the command MUST
  print the human summary.
- The command MUST be a native Ravi CLI command built with the real decorator
  contract (`@Group`, `@Command`, `@Arg`/`@Option`, `@CommandAccess`, `@Returns`),
  registered through the auto-generated barrel (`bun run gen:commands`), with no
  manual registration.
- Exit taxonomy MUST follow `cli`: `0` success (dry-run included), `1` execution
  failure, `2` invalid usage, `3` blocked by confirmation policy.
- With `--json`, failures MUST use the `cli` envelope
  `{success:false, op, error:{code, message, retryable, suggestedAction, acceptedValues?|suggestions?}}`.
- `op` MUST be `storage cleanup` for cleanup; `report`, `summary` and `schedule`
  MUST use their own `op` (`storage report`, `storage summary`, `storage schedule`).
- `cleanup` and `schedule` are mutations and MUST declare
  `@CommandAccess({ kind: "mutate", requiresConfirmation: true })`; the
  confirmation meta-test MUST keep `--execute` as the last declared option.

## Test seams (fixtures only)

The destructive path MUST be exercisable against a controlled fixture without ever
pointing at real host state. The command MUST honor, **only** when
`RAVI_STORAGE_FIXTURE_MODE=1`:

- `RAVI_STORAGE_FIXTURE_TMP_ROOTS` — a `:`-separated list replacing the temp roots;
- `RAVI_STORAGE_FIXTURE_RECEIPT_DIR` — replacement for the receipt directory;
- `RAVI_STORAGE_FIXTURE_ALLOWLIST` — optional replacement of the tmp name allowlist;
- `RAVI_STORAGE_FIXTURE_CODEX_DIR` — replacement for the Codex sessions directory (the area is disabled when unset);
- `RAVI_STORAGE_FIXTURE_BACKUPS_DIR`, `RAVI_STORAGE_FIXTURE_ATTACHMENTS_DIR`,
  `RAVI_STORAGE_FIXTURE_CLAUDE_DIR`, `RAVI_STORAGE_FIXTURE_OMNI_MEDIA_DIR` —
  replacements for the v2 host-class roots;
- `RAVI_STORAGE_FIXTURE_OMNI_DB_JSON` — status@broadcast rows (fixture of the
  read-only Omni query);
- `RAVI_STORAGE_FIXTURE_NOTIFY_OUT` — file sink for `--notify` (never NATS);
- `RAVI_STORAGE_FIXTURE_PROTECTED_ROOTS` — optional fixture-local protected roots
  so the execute-time protected-path gate can be tested without touching the host.

When `RAVI_STORAGE_FIXTURE_MODE` is unset or not `1`, all of them MUST be ignored so
production can never be redirected by environment. Tests and the out-of-candidate
checker MUST rely on these seams; no test may delete outside its fixture.

## Policy

- The policy MUST be compiled from source-controlled constants and MUST be the
  single source of truth. It MUST NOT be read from mutable external config.
- The policy MUST expose a version and a content hash. Both MUST appear in every
  receipt and in `--json` output.
- Allowlists MUST be closed sets. A path not matched by an allowlist MUST NOT be
  a candidate.
- The policy MUST include explicit protected paths that can never be removed,
  regardless of tier, age or allowlist match.

## Eligibility — `routine`

`routine` MAY only consider:

1. `tmp-ravi`: direct children of the host temp root(s) whose **name** matches the
   policy allowlist and whose **age** exceeds the routine age threshold.
   - The allowlist MUST be a closed set of known Ravi prefixes (for example
     `ravi-*`, `observation-plane*`, `skills-cli*`, `skill-gates*`, `tags-cli*`,
     `tag-targets*`, `observer-profiles*`, `cp13-*`).
   - The scan MUST be depth-limited (direct children only) and MUST NOT glob a
     bare temp root.
2. `codex-inactive`: Codex session artifacts that are **unequivocally Ravi's and
   inactive**:
   - the rollout header MUST prove Ravi ownership: the first `session_meta` record
     MUST carry `payload.originator === "ravi"`. `codex_exec` rollouts (direct CLI
     runs) and headers that are missing/unreadable are NOT Ravi's and MUST be
     preserved;
   - no live Codex process references the artifact; and
   - the artifact's most recent modification is older than the policy threshold; and
   - the artifact is not the current session and is not referenced by an active
     Ravi session (liveness read from the Ravi database, read-only).
   - If any of those cannot be proven, the artifact MUST be preserved.

## Eligibility — `weekly`

`weekly` MAY only consider:

1. `backups-superseded`: direct entries of `~/.ravi/backups`. A backup "type" is
   the entry name with its extension and one trailing timestamp removed. Only the
   newest entry of each type is preserved-in-place; older entries of the same type
   are candidates. An entry whose name carries no recognizable timestamp MUST be
   preserved as in doubt — the policy never guesses what a backup belongs to.
2. `instance-attachments`: direct files of `~/ravi/main/attachments` whose name
   matches the saved-attachment allowlist `<epochMs>-<externalId>.<ext>` and whose
   age exceeds 90 days. Anything else in the directory MUST be preserved as in
   doubt; subdirectories are outside the class.
3. `claude-jsonl`: regular `*.jsonl` files under `~/.claude/projects` older than
   90 days. Nothing under a `memory` path segment MUST ever be a candidate,
   regardless of age (`*/memory/*` is durable agent memory, not a transcript).
4. `omni-broadcast-mp4`: `.mp4` files under `~/.omni/data/media` that are
   **positively matched** to a `status@broadcast` message: the message's
   `media_local_path` resolves to this file and the file name equals that
   message's `external_id`. The file and the message MUST both be older than
   7 days. No match, a mismatched external id, or an unavailable Omni source MUST
   preserve the file as in doubt.
5. `omni-orphan`: Omni-managed objects that are **provably orphan or
   unreferenced** — no hold and no live reference from Omni.
   - The reference/hold check MUST query the canonical Omni surface.
   - If Omni is unreachable, errored, or returns an indeterminate answer, every
     Omni object MUST be preserved and the limitation MUST be recorded.
   - Current status: no canonical hold/reference surface exists, so this class is
     preserved entirely (fail-closed) and MUST NOT emit candidates.
6. `tasks-terminal`: Task work directories and Git worktrees for tasks that are:
   - terminal (`done`, `failed` or archived); and
   - older than the policy threshold (20 days); and
   - removed through the canonical Task/Git lifecycle (for example
     `git worktree remove`), never by raw recursive deletion of a live tree.
   - A task that is active, blocked or unknown MUST be preserved.

## Invariants — fail-closed

1. Ambiguity MUST preserve data. The default outcome of any uncertainty is
   "preserved", never "candidate".
2. The engine MUST NOT delete: auth/credentials; any active session file; any
   database or WAL/SHM file; media under an Omni hold or reference; active or
   non-terminal tasks; a repository or worktree without a canonical lifecycle
   removal path; and anything outside an exact allowlist match.
3. Symlinks MUST NOT be followed for deletion. The engine MUST use `lstat`,
   MUST refuse to delete a symlink target, and MUST verify that each candidate's
   resolved real path is contained within its allowlist root (no traversal).
4. A single-instance lock MUST guard the operation. A concurrent invocation MUST
   fail closed with a stable code and MUST NOT partially mutate. A lock that is
   unreadable (e.g. observed between creation and the pid write) MUST NOT be
   stolen until it is provably old; only a dead holder or an old unreadable lock
   may be taken over.
5. Dry-run MUST be side-effect free on candidate roots: it MUST NOT delete, move,
   truncate, or write into them. A dry-run writes its receipt with
   `freedBytes: 0` and the estimate in `wouldFreeBytes`; a receipt MUST NEVER
   record an estimate as released space.
6. `--execute` MUST only act on candidates that the same policy would have shown
   in dry-run; the eligible set MUST NOT differ between dry-run and execute for
   the same host state.
7. Every removal MUST be measured and recorded with the rule that selected it
   (`removedSample`: path, bytes, reason; `removed`: paths). A partial failure MUST
   be reported, MUST NOT be masked, and MUST exit non-zero. A candidate the
   execute gate deterministically refuses (late age, ownership, match or protected
   path change) MUST be recorded as `blocked` and MUST NOT turn a healthy run red.
8. The policy version+hash MUST be recorded per run. A receipt whose hash does not
   match the running policy MUST be treated as drift: excluded from `summary`
   totals, listed in `driftedReceipts`, and surfaced with a non-zero exit.
9. The execute gate MUST re-verify every candidate immediately before removal:
   class containment, allowlist, current age against the class threshold,
   Ravi ownership for Codex rollouts, the `status@broadcast` match for Omni
   videos, and protected paths. A candidate whose signal changed is preserved.
10. Protected roots MUST stay protected, and a class root that itself lives inside
    a protected root (`~/.codex/sessions`, `~/.ravi/tasks`) MUST be exempt only for
    its own allowlisted candidates — never for the whole protected root.
11. A dry-run estimate MUST NEVER be subtracted from disk usage or reported as
    "freed".

## Output

- Human output MUST be short and MUST state: space **before**, **after** and
  **freed** (or **would free** on a dry-run); areas cleaned; areas preserved;
  blocked candidates; errors; and the receipt id.
- Byte formatting MUST use the correct unit at every step (1024 B = `1.0 KB`,
  1024² B = `1.0 MB`, ...), so human output never understates by 1024×.
- `cleanup --json` MUST include at least: `tier`, `dryRun`, `policyVersion`,
  `policyHash`, `freedBytes`, `wouldFreeBytes`, per-class summaries, `disk`
  (`before`/`after`), `errors`, `blocked`, `limitations`, `removed`, `preserved`,
  `receiptId`, `receiptPath`.
- `report --json` MUST include `generatedAt`, `policyVersion`, `policyHash`, one
  row per class with `scopeBytes`, `eligibleBytes`, `inDoubtBytes`,
  `preservedBytes`, `candidates`, `preserved`, `limitations`, plus `totals` and
  `disk`.
- `summary --json` MUST include `since`, `runs`, `executedRuns`, `freedBytes`,
  `wouldFreeBytes`, per-class freed bytes, `driftedReceipts` and `invalidReceipts`.
- `summary` MUST count only executed receipts (`dryRun: false`) in `freedBytes`.
- `--json` and human output MUST agree on the same numbers for the same run.

## Receipts and retention

- Each run MUST write one compact receipt (`ravi.storage.receipt/v2`) under the
  policy-defined receipt directory, with `freedBytes` (actually removed),
  `wouldFreeBytes` (estimate), per-class summaries, the `disk` before/after
  snapshot, `errors`, `blocked`, `limitations`, `removed`, a bounded
  `removedSample` and a bounded `preservedSample`.
- A damaged receipt (invalid date or non-finite numbers) MUST be reported as
  invalid, never silently normalized to zero.
- Receipts MUST NOT be eligible cleanup candidates, and receipt retention MUST be
  bounded (fixed max count and/or max age). Retention pruning MUST NOT recurse
  into or re-scan the receipt directory as an allowlist root, and MUST NOT delete
  the receipt currently being written. The in-flight receipt counts against the
  cap, so the directory never holds `maxCount + 1` files.
- Receipt retention MUST run on every run, dry-run included: a dry-run writes a
  receipt too, so leaving pruning to `--execute` leaks files.
- Receipt size MUST be bounded: no unbounded per-file listings; only aggregate
  counts plus a bounded sample of paths.

## Acceptance criteria

- `ravi storage --help` lists exactly the four operations; `cleanup --help`
  documents `--tier`, `--notify`, `--execute` and the accepted tier values.
- Dry-run over a fixture with eligible, ambiguous and held objects removes
  nothing and reports `freedBytes: 0` plus the estimate in `wouldFreeBytes`.
- `--execute` on the same fixture removes exactly the dry-run eligible set, and
  the human "freed" value equals `freedBytes` in `--json`.
- `report` over a fixture with v2 classes accounts every class and writes nothing.
- `summary` over a dry-run plus an execute reports only the bytes the execute
  removed, and flags a receipt recorded under a different policy hash.
- Adversarial fixtures (path traversal, symlink escape, staged lock, refreshed
  mtime, foreign Codex originator, unmatched `status@broadcast` id, policy drift,
  receipt cap, receipt recursion) all fail closed and are covered by checks in
  [`CHECKS.md`](./CHECKS.md).

The status of this spec is `draft` until the implementation and the checks in
[`CHECKS.md`](./CHECKS.md) pass on a frozen candidate and are independently
reviewed.
