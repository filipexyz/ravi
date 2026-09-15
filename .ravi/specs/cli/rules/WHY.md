# Rules agent-first CLI contract / WHY

The migration question for `rules import` was: add `--execute`, or declare the
existing flags as the brake? Inspection favored declaration, decisively:

- Without `--write`, import is ALREADY a dry-run — it lists every candidate
  with a `would-create`/`would-overwrite` verb and writes nothing. That is the
  Manual v2 brake semantics, shipped before the contract existed.
- Even with `--write`, the destructive path (overwriting a previously
  imported rule) requires a SECOND opt-in: `--force`. Without it, existing
  files are skipped and counted as `skippedExisting`. The domain therefore
  asks for confirmation twice before destroying anything.
- The `runtime/prompt-rules` normative spec, its RUNBOOK/CHECKS, the
  `ravi-rules` skill and the tests all teach `--write`/`--force` today.
  Renaming or stacking `--execute` on top would break that contract surface
  and produce two brakes with different exit codes for the same op.

The accepted trade-off, documented here: the native dry-run exits 0 with the
plan in the payload, not 3 with a `WRITE_REQUIRES_EXECUTE` envelope. This is
the same precedent set by `cli/skills` for `grant-batch --dry-run` — a
pre-existing, didactic brake is kept, not renamed.

`RULE_NOT_FOUND` was considered and rejected: the domain has no per-rule
lookup (no `rules show <rule>`), so there is no entity universe to suggest
from. The real error surface is the provider filter — a positional value with
exactly three valid options — which became a proper `USAGE_ERROR` (exit 2,
`acceptedValues`, bigram `suggestions`) instead of a plain-text exit 1, and
fires before any filesystem access.
