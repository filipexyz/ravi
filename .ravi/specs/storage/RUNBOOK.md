# Storage — Runbook (v2)

Operational reference and surface inventory for `ravi storage`. The v1 inventory
below was observed on the live host on 2026-09-14 against `ravi.bot@3.260914.3`;
the v2 additions were measured on 2026-10-26 (`origin/dev` 0dd8143a).

## Run

```bash
# Read-only first: what each class holds, eligible vs in doubt.
ravi storage report --json
ravi storage report

# What the receipt ledger says was freed in the last week.
ravi storage summary --since 7d --json
ravi storage summary --since 7d

# Dry-run (default; mutates nothing). `would free` is an estimate.
ravi storage cleanup --tier routine --json
ravi storage cleanup --tier weekly  --json

# Mutation gate: explicit --execute, same candidate set the dry-run showed.
ravi storage cleanup --tier routine --execute
ravi storage cleanup --tier weekly  --execute --notify ravi-main-2-0-cloudopus

# Idempotent weekly cron (dry-run prints the plan and exits 3).
ravi storage schedule --json
ravi storage schedule --execute
```

Receipts go to the policy receipt directory (default `~/.ravi/storage/receipts/`)
with bounded retention and are never cleanup candidates themselves. A dry-run
writes a receipt with `freedBytes: 0` and the estimate in `wouldFreeBytes`.

## Classes (policy v2)

| class | tier | root | rule |
|---|---|---|---|
| `tmp-ravi` | routine | host temp root(s), depth 1 | closed name allowlist + 24h |
| `codex-inactive` | routine | `~/.codex/sessions` | `originator=ravi` + not-live + 72h |
| `backups-superseded` | weekly | `~/.ravi/backups` | keep newest of each type |
| `instance-attachments` | weekly | `~/ravi/main/attachments` | `<epochMs>-<externalId>.<ext>`, 90d |
| `claude-jsonl` | weekly | `~/.claude/projects` | `*.jsonl`, 90d, never `*/memory/*` |
| `omni-broadcast-mp4` | weekly | `~/.omni/data/media` | matched `status@broadcast` id, 7d |
| `omni-orphan` | weekly | `~/.omni/data` | always preserved (no hold surface) |
| `tasks-terminal` | weekly | `~/.ravi/tasks` | terminal + 20d + `git worktree remove` |

## Surface inventory (LOCALIZE evidence)

### 1. Ravi tmp namespaces (`routine`)
- Roots: the host temp root (`/tmp`), scanned at depth 1 only.
- Allowlist (closed set; from `ravi-disk-janitor.sh`, which remains the safety
  reference): `ravi-*`, `observation-plane*`, `skills-cli*`, `skill-gates*`,
  `tags-cli*`, `tag-targets*`, `observer-profiles*`, `cp13-*`.
- Reference implementation: `/home/ravi/scripts/ravi-disk-janitor.sh` (age gate
  default 24h; never globs a bare root; never follows symlinks by design).

### 2. Codex sessions (`routine`, `codex-inactive`)
- Layout: `~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-<ISO>-<uuid>.jsonl`.
  The first line is `session_meta` with `session_id`, `cwd`, `originator`,
  `cli_version`.
- Measured on 2026-10-26: 136 rollouts (753.5 MiB) — 131 with
  `payload.originator = "ravi"` (753.1 MiB), 5 with `originator = "codex_exec"`
  (0.4 MiB, direct `codex exec` runs, not Ravi's).
- Inactive test (fail-closed): `originator === "ravi"` **and** older than the
  routine threshold **and** no live Ravi session references the session id **and**
  no Codex process is running. Any other originator or an unreadable header is
  preserved as in doubt.
- The execute gate re-reads the header and re-asks liveness right before removal.

### 3. Backups (`weekly`, `backups-superseded`)
- Root: `~/.ravi/backups`. A "type" is the name minus its extension and one
  trailing timestamp (`-20260101T000000Z`, `-2026-01-01`, ...).
- Only the newest entry of each type stays. Names without a recognizable
  timestamp are preserved as in doubt, never grouped with unrelated artifacts.

### 4. Instance attachments (`weekly`, `instance-attachments`)
- Root: `~/ravi/main/attachments`, flat files named
  `<epochMs>-<externalId>.<ext>` (WhatsApp inbound media).
- Only that shape older than 90 days is a candidate; other names are preserved as
  in doubt; subdirectories are outside the class.

### 5. Claude transcripts (`weekly`, `claude-jsonl`)
- Root: `~/.claude/projects/**/*.jsonl`, depth-bounded.
- Older than 90 days is a candidate. Nothing under a `memory` path segment is
  ever a candidate: it is durable agent memory, not a transcript.

### 6. Omni state (`weekly`)
- Service: pm2 apps `omni-api` and `omni-nats`; CLI `omni` (server `default`,
  configured). Data root `~/.omni/data/` → `media/`, `nats/`, `pgserve/`.
- `omni-broadcast-mp4`: the probe reads the Omni PostgreSQL database **read-only**
  for `status@broadcast` messages (`external_id`, `media_local_path`,
  `platform_timestamp`). A video is a candidate only when its relative path
  matches a row **and** the file stem equals that row's `external_id`, and both
  are older than 7 days. The execute gate re-queries the probe.
- `omni-orphan`: **no explicit hold command exists** on the CLI. The class stays
  fail-closed: everything is preserved and the limitation is recorded.
- If the Omni source is unavailable, every video is preserved as in doubt.

### 7. Task lifecycle (`weekly`, `tasks-terminal`)
- Task dirs: `~/.ravi/tasks/task-*/TASK.md` with YAML frontmatter `status`
  (106 dirs observed at v1 inventory; 73 terminal `done`/`failed`).
- Worktrees: `git worktree list` per repository. Removal MUST go through the
  canonical lifecycle (`git worktree remove`), never raw `rm -rf` of a tree.
- Tasks that are `open`/`in_progress`/`blocked` or unknown MUST be preserved.

### 8. Receipts
- Root: `~/.ravi/storage/receipts/`, schema `ravi.storage.receipt/v2`, bounded by
  `RECEIPT_MAX_COUNT` and `RECEIPT_MAX_AGE_MS`.
- The in-flight receipt counts against the cap. Pruning runs on every run
  (dry-run included) and never re-scans the receipt directory as an allowlist
  root.
- `summary` counts only executed receipts and excludes/flags receipts written
  under a different policy hash.

## Protected roots

Default protected roots: `~/.ravi`, `~/.config/ravi`, `~/.pi`, `~/.codex`,
`~/.omni`. A class root inside a protected root (`~/.codex/sessions`,
`~/.ravi/tasks`) is exempt from that check **only for its own allowlisted
candidates**; everything else inside the protected root stays protected.

## Verification

Release checks (run in the candidate worktree/CI):

```bash
bun run build
bun run typecheck
bun run test
bun src/ci/run-quality-gate.ts
```

Fixture-only behavioral checks live in the test suites:

- `src/storage/storage.test.ts` — policy seams, containment, measurement, parser;
- `src/storage/storage-v2.test.ts` — v2 classes, report, summary, notify, schedule;
- `src/cli/commands/storage.test.ts` — cleanup contract, execute gate, lock, CLI.

## Open items

- Exact persisted location/semantics of Omni holds: no canonical hold surface was
  found, so `omni-orphan` stays fail-closed (preserve all, record the limitation).
- `measureBytes` bounds large trees (8 GiB / 200k entries) and reports the capped
  value as exact; a truncation flag in `report` is a known follow-up.
- A `config.json` Omni installation that only carries `OMNI_API_URL`/`OMNI_API_KEY`
  (no database URL) leaves `omni-broadcast-mp4` without a source; it preserves
  every video and records the limitation.
