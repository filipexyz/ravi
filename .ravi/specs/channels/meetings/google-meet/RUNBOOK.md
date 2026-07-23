# Google Meet Provider / RUNBOOK

## Debug Flow

1. Read the provider rules:
   `ravi specs get channels/meetings/google-meet --mode rules --json`.
2. Confirm the provider joins through the normal Meet admission flow as a
   visible Ravi participant.
3. Inspect capture source, admission status, participant list, transcript
   segments, media refs, diagnostics, and leave/finalize result.
4. Verify normalized output uses `channel=meet` and `provider=google-meet`.
5. Pass the finalized result to the raw artifact renderer; the provider should
   not summarize or decide.

## Validation

```bash
bun test src/meetings/google-meet/recorder-run.test.ts
```
