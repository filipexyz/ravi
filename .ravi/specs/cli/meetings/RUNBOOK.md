# Meetings agent-first CLI contract / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get cli/meetings --mode rules --json`.
2. Reproduce the failing call with `--json` and read `error.code` first.
3. Exit `1` + `MEETING_PROFILE_NOT_FOUND`: read `error.suggestions` (local
   catalog) and retry with a real profile id, or list with `ravi meetings
   profiles list --json`.
4. Before any new/risky join, run the write-brake equivalent: `ravi meetings
   join ... --dry-run --json` and review `args`/`env`; only then run without
   `--dry-run`.
5. Provider executable errors: install the recorder on PATH or set
   `RAVI_GOOGLE_MEET_RECORDER_BIN`.
6. Async join lifecycle: follow `ravi artifacts events <artifact-id> --json`;
   never re-join in a loop.
7. If profiles show reports not-found for a profile that exists, the catalog
   check regressed — see `meetingProfileExists` in
   `src/cli/commands/meetings.ts`.

## Validation

```bash
bun test src/cli/commands/meetings.test.ts
```

Live checks (dry-run only):

```bash
ravi meetings profiles show ghost --json                       # expect exit 1 + suggestions
ravi meetings join --provider google-meet --url <meet-url> \
  --dry-run --json                                             # expect mode: dry-run, no join
ravi meetings profiles list --fields id,label --json           # expect compact items
```
