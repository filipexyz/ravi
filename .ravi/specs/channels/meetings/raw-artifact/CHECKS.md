# Meeting Raw Artifact / CHECKS

## Checks

- `meet.md` MUST be generated automatically when the meeting finalizes.
- The artifact MUST include meeting metadata, participants when available,
  transcript segments, text chat, Ravi output, media refs, diagnostics, and
  lineage.
- Transcript entries MUST preserve speaker and timestamps when available.
- The artifact MUST NOT include AI-generated summaries, decisions, action
  items, or interpretation.
- The artifact MUST be registered in the Ravi artifact ledger and handed back
  to the origin session.
- `bun test src/meetings/raw-artifact.test.ts` SHOULD pass after changing the
  renderer or handoff.
