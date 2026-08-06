# Tag-rules agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/tag-rules --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `TAG_RULE_NOT_FOUND`: read `error.suggestions` — real rule ids
   similar to what was asked. Retry with one of them, or run
   `ravi tag-rules list --json --fields id,scope`.
4. Exit `1` + `CONTACT_NOT_FOUND`: the target contact does not exist (or is
   out of scope). There are no suggestions by design — resolve the id with
   `ravi contacts list` / `ravi contacts find`.
5. Tags changed after a run WITHOUT `--apply`: that is a dry-run regression —
   check that the command still passes `apply: Boolean(applyChanges)` to the
   engine and that `runTagRulesForContact`/`tickTagRules` still gate writes on
   `options.apply`.
6. Tags NOT changing WITH `--apply`: check `tag-rules explain --target
   contact:<id>` first — the rule may simply not match; then check the
   cascade guard (`cascade-cycle-skipped` in `skipped`).
7. Exit `3` on any tag-rules op is a regression: this domain has no
   `--execute` brake — its write switch is `--apply`, and the previews exit 0.
8. Parser-level errors (unknown flag) MUST exit 2 with the `USAGE_ERROR`
   envelope and `acceptedFlags`.

## Validation

```bash
bun test src/cli/commands/tag-rules.test.ts
```

Live checks against the local CLI (read-only or dry-run; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi tag-rules show nope --json                          # expect exit 1 + suggestions
ravi tag-rules evaluate nope --target contact:<id> --json  # expect exit 1 + suggestions
ravi tag-rules explain --target contact:nope --json      # expect exit 1 + CONTACT_NOT_FOUND
ravi tag-rules tick --json                               # preview only; tags unchanged
ravi tag-rules list --json --fields id,scope             # expect compact rules
```
