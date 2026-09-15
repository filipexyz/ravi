# Runtime Session Visibility Checks

## Automated Checks

```bash
bun test src/runtime/session-visibility.test.ts src/runtime/session-trace.test.ts
bun test src/runtime/claude-provider.test.ts src/runtime/codex-provider.test.ts src/runtime/pi-provider.test.ts
bun test src/runtime/provider-contract.test.ts
```

## Contract Assertions

- Every provider returns the same visibility payload shape.
- Unsupported token or compact fields remain explicit instead of disappearing.
- A newer persisted skill snapshot wins over stale live state, while a newer
  live snapshot wins over stale persistence.
- `loadedSkills` includes only observed loaded records.
- Provider discovery, synchronization, prompt advertisement, and approval do
  not populate `loadedSkills`.
- Pi exposes only allowlisted advertised records with declared system-prompt
  evidence until explicit load evidence exists.
- Compaction and session reset clear the conservative loaded projection.
- A missing session returns a structured error rather than an empty payload.

## Manual Smoke

1. Start one session for each supported provider.
2. Query `ravi sessions visibility <session> --json` before and after a turn.
3. Read one skill through `ravi skills show <skill> --json` and inspect the next
   visibility snapshot.
4. Trigger a compact/reset in a disposable session and verify `loadedSkills`
   returns empty afterward.
