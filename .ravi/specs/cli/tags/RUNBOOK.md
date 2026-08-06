# Tags agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/tags --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
3. Exit `1` + `TAG_NOT_FOUND`: read `error.suggestions` — real slugs/labels
   similar to what was asked. Retry with one of them, or run
   `ravi tags list --json --fields slug,label` to see the full surface.
4. Exit `1` with plain `Binding not found ...` text on detach: the tag exists
   but is not attached to that asset — check with
   `ravi tags search --tag <slug> --json`.
5. Exit `3` on any tags op is a regression: this domain declares ZERO braked
   ops — nothing here should emit `WRITE_REQUIRES_EXECUTE`.
6. If an unknown slug produces a raw `Error: Tag not found ...` instead of the
   envelope, the rethrow wrapper (`rethrowTagCommandError`) lost the throw
   mapping — see `src/cli/commands/tags.ts`.
7. Parser-level errors (unknown flag) still print commander's default text:
   known gap while `tags` is not in `AGENT_CONTRACT_DOMAINS`
   (`src/cli/index.ts`).

## Validation

```bash
bun test src/cli/commands/tags.test.ts
```

Live checks against the local CLI (isolated `RAVI_STATE_DIR`):

```bash
ravi tags show nope --json                     # expect exit 1 + suggestions
ravi tags set nope label X --json              # expect exit 1 + TAG_NOT_FOUND
ravi tags attach nope --contact <id> --json    # expect exit 1, no binding written
ravi tags list --json --fields slug,kind       # expect compact items
ravi tags search --tag <slug> --json --fields tagSlug  # expect compact items
```
