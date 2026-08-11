# Ravi Commands agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/commands --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `COMMAND_NOT_FOUND`: read `error.suggestions` — real command
   ids from the same registry (agent + global dirs). Retry with one, or list
   with `ravi commands list --json`.
4. Exit `1` + `AGENT_NOT_FOUND`: the `--agent` id does not exist in the local
   config; `error.suggestions` carries similar agent ids.
5. Exit `1` from `commands validate` WITHOUT an envelope: that is the
   pre-existing verdict "validation errors exist in command files" — inspect
   the printed issues, fix the Markdown files.
6. There is NO exit 3 in this domain — `run` only renders; if a commands op
   ever returns 3, someone added a brake without updating this spec.
7. To check whether a command expanded in a real message, use
   `ravi sessions trace <session> --message <id> --explain --json` (see the
   commands skill).

## Validation

```bash
bun test src/cli/commands/commands.test.ts
```

Live checks against the local CLI (read-only):

```bash
ravi commands show nope --json                  # expect exit 1 + COMMAND_NOT_FOUND + suggestions
ravi commands list --agent ghost --json         # expect exit 1 + AGENT_NOT_FOUND + suggestions
ravi commands list --fields id,scope --json     # expect compact items
ravi commands run restart --json -- "motivo"    # renders the prompt; no session publish
```
