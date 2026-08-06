# Heartbeat agent-first CLI contract / RUNBOOK

## Debug Flow

1. Reproduce the failing call with `--json` and read `error.code` first; the
   code, not the message, is the branch point.
2. Exit `1` + `AGENT_NOT_FOUND`: read `error.suggestions` — live agent ids and
   names similar to what was asked. Retry with one of them (or list with
   `ravi agents list --json`).
3. Exit `2`: read `error.acceptedFlags`; the list is authoritative for that op.
4. Exit `3` MUST NOT happen in this domain — there is no braked op. If a
   heartbeat command ever exits 3, someone added a brake against the declared
   contract; check SPEC.md before "fixing" the caller.
5. `trigger` returning `status: "skipped"` is a success: the agent exists but
   `HEARTBEAT.md` is missing or empty in its workspace. Create the file, do
   not retry blindly.

## Common Operations

```bash
ravi heartbeat status --json --fields agent,heartbeat   # compact discovery
ravi heartbeat show main --json                          # one agent's config
ravi heartbeat enable main 30m                           # unbraked, reversible
ravi heartbeat set main active-hours 09:00-18:00         # unbraked, reversible
ravi heartbeat trigger main                              # unbraked: fires own heartbeat
ravi daemon logs -f                                      # watch the run
```

## Validation

```bash
bun test src/cli/commands/heartbeat.test.ts
```

Live checks against the local CLI (read-only or reversible; use an isolated
`RAVI_STATE_DIR`):

```bash
ravi heartbeat show nope --json                      # expect exit 1 + suggestions
ravi heartbeat status --no-such-flag --json          # expect exit 2 + acceptedFlags
ravi heartbeat status --fields agent --json          # expect compact items
ravi heartbeat trigger <agent-id> --json             # expect triggered/skipped, exit 0, no --execute
```
