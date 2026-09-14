# Storage — Runbook

Operational reference and surface inventory for `ravi storage cleanup`. All paths
below were observed on the live host on 2026-09-14 against `ravi.bot@3.260914.3`.

## Run

```bash
# Always start with the dry-run (default; mutates nothing).
ravi storage cleanup --tier routine --json
ravi storage cleanup --tier weekly  --json

# Human summary (before / after / freed, areas, receipt id).
ravi storage cleanup --tier routine

# Mutation gate: explicit --execute, same candidate set the dry-run showed.
ravi storage cleanup --tier routine --execute
```

Receipts go to the policy receipt directory (default `~/.ravi/storage/receipts/`)
with bounded retention and are never cleanup candidates themselves.

## Surface inventory (LOCALIZE evidence)

### 1. Ravi tmp namespaces (`routine`)
- Roots: the host temp root (`/tmp`), scanned at depth 1 only.
- Allowlist (closed set; from `ravi-disk-janitor.sh`, which remains the safety
  reference): `ravi-*`, `observation-plane*`, `skills-cli*`, `skill-gates*`,
  `tags-cli*`, `tag-targets*`, `observer-profiles*`, `cp13-*`.
- Reference implementation: `/home/ravi/scripts/ravi-disk-janitor.sh` (age gate
  default 24h; never globs a bare root; never follows symlinks by design).

### 2. Codex sessions (`routine`, `codex-inactive`)
- Layout: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`
  (131 files observed). The first line is `session_meta` with `session_id`,
  `cwd`, `originator`, `cli_version`.
- Inactive test (fail-closed): older than the routine threshold **and** no live
  process references the session id or its `cwd` **and** not the current session.
- Live processes observed: none at inventory time (`codex` not running). When any
  uncertainty remains, preserve.

### 3. Omni state (`weekly`, `omni-orphan`)
- Service: pm2 apps `omni-api` and `omni-nats`; CLI `omni` (server `default`,
  configured). Data root `~/.omni/data/` → `media/`, `nats/`, `pgserve/`.
- Reference query surface: `omni media list|ls`, `omni messages get <id>`.
- **No explicit `hold` command was found** on the CLI. Therefore the rule stays
  fail-closed: if a hold/reference cannot be positively disproved — Omni
  unreachable, command errored, or answer indeterminate — every Omni object is
  preserved and the limitation is recorded. This is a known gap to close (or
  explicitly bound) during IMPLEMENT; it MUST NOT be guessed.

### 4. Task lifecycle (`weekly`, `tasks-terminal`)
- Task dirs: `~/.ravi/tasks/task-*/TASK.md` with YAML frontmatter `status`
  (106 dirs observed; 73 terminal `done`/`failed`).
- Worktrees: `git worktree list` per repository. Removal MUST go through the
  canonical lifecycle (`git worktree remove`), never raw `rm -rf` of a tree.
- Tasks that are `open`/`in_progress`/`blocked` or unknown MUST be preserved.

### 5. Receipts
- No prior native receipt directory exists. The policy defines one
  (`~/.ravi/storage/receipts/`), bounded by max count and/or max age.
- Receipt pruning MUST NOT re-scan the receipt directory as an allowlist root and
  MUST NOT delete the in-flight receipt.

## Verification

The out-of-candidate checker is the deterministic gate:

```bash
bun /home/ravi/.ravi/tasks/task-f3f39d9a/checker/storage-plan-checker.ts \
  --candidate /home/ravi/.ravi/tasks/task-84c0c0f1/storage-builder-worktree \
  --behavioral --json
```

- Static mode validates the frozen spec and the candidate surface.
- `--behavioral` builds a throwaway fixture under the OS temp dir, uses the
  `RAVI_STORAGE_FIXTURE_MODE=1` seams, and asserts: usage exits `2`, dry-run
  mutates nothing, `--execute` removes only the eligible set, and the recent dir /
  symlink target survive.
- Expected on a correct candidate: all checks PASS, exit `0`.

## Open items

- Exact persisted location/semantics of Omni holds (must be resolved or the
  restriction stated as bounded fail-closed).
- Final numeric thresholds (routine tmp age, Codex age, task age 20d) are frozen
  in the policy constants, not in this runbook.
- Wire the checker into the independent verification task (task-67069d29) as its
  required input.
