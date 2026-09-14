# Storage — Why

## Why one command, not four

The original scope proposed `storage status`, `plan`, `cleanup` and `policy`.
The approved KISS v2 steer (user, 2026-09-13) collapsed this to one operation:
`cleanup --tier routine|weekly`. The tier selection *is* the plan, the human
summary *is* the status, and the policy is a fixed source-controlled constant —
so a separate `policy` command would only re-expose compiled constants and add a
drift surface. Fewer operations means fewer ways to mislead an operator about
what will be deleted.

## Why dry-run is the default

Disk is the resource; deletion is irreversible. The safe default MUST be a run
that mutates nothing, so a human or agent can read the exact before/after/freed
picture before authorizing. `--execute` is the explicit, single mutation gate and
MUST produce the same candidate set the dry-run showed.

## Why fail-closed on ambiguity

The prior failure mode was the opposite of neglect: a heuristic that deleted
state to recover disk. This domain accepts a smaller freed total in exchange for
never deleting active state. Every indeterminate signal (Omni unreachable, lock
contention, unparseable Git state, unknown task status) resolves to "preserve".

## Why reuse `ravi-disk-janitor` logic

The shell janitor already encodes the safe allowlist, the age gate and the
Git all-clean gate. Rather than inventing a framework, the native command reuses
those safety rails and replaces only the unsafe parts: bare globbing, raw
recursive deletion of worktrees, and unbounded receipts.

## Why receipts

A cleanup that cannot be audited is indistinguishable from data loss. The receipt
records policy version+hash, the before/after/freed numbers, per-area reasons and
the receipt id. Retention is bounded, and receipts are explicitly excluded from
being cleanup candidates so pruning can never recurse into itself.

## Premise / source freeze

The task froze the source that provably reproduced the then-live bundle
(`ravi.bot@3.260908.2`, source `d79b313…`). On 2026-09-14 the live daemon was
updated to `ravi.bot@3.260914.3`; building on the old base would have downgraded
production because the live bundle contains the pi permission bridge
(`src/runtime/pi-tool-permissions.ts`) and `ravi-host` permission mode absent at
`d79b313…`. The worktree was re-based to `v3.260914.3` = `c8f15ab…`, proven by
matching the installed source map for all 577 first-party `src/` entries.

Local `bun 1.3.8` cannot reproduce the published bundle byte-for-byte because CI
builds with `bun 1.3.11`; source lineage is therefore proven by source identity,
and byte-identity remains an open toolchain item.

## Alternatives considered

- **Extending `ravi-disk-janitor.sh`** — rejected: no typed envelope, no exit
  taxonomy, no JSON contract, no receipts, and unsafe raw `rm -rf` of worktrees.
- **A generic storage framework** — rejected by KISS v2 steer; scope is one
  operation.
- **A `hold` subsystem inside storage** — rejected; holds are owned by Omni and
  are only *consulted* here, fail-closed.
