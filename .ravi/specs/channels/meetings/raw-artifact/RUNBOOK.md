# Meeting Raw Artifact / RUNBOOK

## Debug Flow

1. Read the artifact contract:
   `ravi specs get channels/meetings/raw-artifact --mode rules --json`.
2. Locate the finalized meeting session and its artifact id.
3. Inspect `meet.md` for metadata, participants, transcript segments, text chat,
   Ravi agent output, media refs, capture diagnostics, and lineage.
4. Verify timestamps, speaker labels, and raw provenance are preserved when
   available.
5. Confirm the origin session receives the artifact as context after
   generation.

## Validation

```bash
bun test src/meetings/raw-artifact.test.ts
```
