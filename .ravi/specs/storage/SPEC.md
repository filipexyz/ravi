---
id: storage
title: "Storage"
kind: domain
domain: storage
capabilities:
  - cleanup
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
  - src/storage/receipts.ts
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

- one command surface: `ravi storage cleanup --tier <routine|weekly> [--execute] [--json]`;
- a fixed, versioned policy (allowlists, age thresholds, protected paths) as the
  single source of truth;
- eligibility decisions and fail-closed ambiguity handling;
- the human summary (space before / after / freed, areas cleaned, preserved, errors);
- the compact receipt with bounded retention.

`storage` does NOT own and MUST NOT implement:

- separate `status`, `plan` or `policy` commands (the tier selection *is* the plan);
- dashboards, 6-hour monitors, monthly backups or MCP surfaces;
- a generic cleanup framework beyond this one operation;
- cron scheduling (owned by `cron`; this spec defines no schedule);
- installing, restarting, deploying or deleting real host data during tests.

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

The only public surface is:

```
ravi storage cleanup --tier <routine|weekly> [--execute] [--json]
```

- The group is `storage`; the operation is `cleanup`. No other operation MUST exist.
- `--tier` is REQUIRED and MUST accept exactly `routine` and `weekly`.
- Dry-run is the default. Mutation MUST require the explicit `--execute` flag.
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
- `op` MUST be `storage cleanup`.

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
2. `codex-inactive`: Codex session artifacts that are **unequivocally inactive**:
   - no live Codex process references the artifact; and
   - the artifact's most recent modification is older than the policy threshold; and
   - the artifact is not the current session, not referenced by an active agent or
     task, and not a lock/DB/WAL path.
   - If any of those cannot be proven, the artifact MUST be preserved.

## Eligibility — `weekly`

`weekly` MAY only consider:

1. `omni-orphan`: Omni-managed objects that are **provably orphan or
   unreferenced** — no hold and no live reference from Omni.
   - The reference/hold check MUST query the canonical Omni surface.
   - If Omni is unreachable, errored, or returns an indeterminate answer, every
     Omni object MUST be preserved and the limitation MUST be recorded.
2. `tasks-terminal`: Task work directories and Git worktrees for tasks that are:
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
   fail closed with a stable code and MUST NOT partially mutate.
5. Dry-run MUST be side-effect free: it MUST NOT delete, move, truncate, or write
   into candidate roots, and MUST NOT write receipts as if a mutation occurred.
6. `--execute` MUST only act on candidates that the same policy would have shown
   in dry-run; the eligible set MUST NOT differ between dry-run and execute for
   the same host state.
7. Every removal MUST be measured (bytes before/after) and individually recorded
   with the rule that selected it. A partial failure MUST be reported, MUST NOT be
   masked, and MUST exit non-zero.
8. The policy version+hash MUST be recorded per run. A receipt whose hash does not
   match the running policy MUST be treated as drift and surfaced, not silently
   reused.

## Output

- Human output MUST be short and MUST state: space **before**, **after** and
  **freed**; areas cleaned; areas preserved; errors; and the receipt id.
- `--json` MUST include at least: `tier`, `dryRun`, `policyVersion`,
  `policyHash`, `bytesBefore`, `bytesAfter`, `freedBytes`, per-area candidate
  counts, per-area reasons, `errors`, and `receiptId`.
- `--json` and human output MUST agree on the same numbers for the same run.

## Receipts and retention

- Each run MUST write one compact receipt under the policy-defined receipt
  directory.
- Receipts MUST NOT be eligible cleanup candidates, and receipt retention MUST be
  bounded (fixed max count and/or max age). Retention pruning MUST NOT recurse
  into or re-scan the receipt directory as an allowlist root, and MUST NOT delete
  the receipt currently being written.
- Receipt size MUST be bounded: no unbounded per-file listings; only aggregate
  counts plus a bounded sample of paths.

## Acceptance criteria

- `ravi storage cleanup --help` documents exactly one operation and the accepted
  tier values.
- Dry-run over a fixture with eligible, ambiguous and held objects removes
  nothing and reports the correct before/after/freed.
- `--execute` on the same fixture removes only the unambiguous eligible objects.
- Adversarial fixtures (path traversal, symlink escape, active lock, active
  worktree, Omni hold, policy drift, receipt recursion) all fail closed and are
  covered by checks in [`CHECKS.md`](./CHECKS.md).

The status of this spec is `draft` until the implementation and the checks in
[`CHECKS.md`](./CHECKS.md) pass on a frozen candidate and are independently
reviewed.
