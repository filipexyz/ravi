# Google Meet Provider / CHECKS

## Checks

- The provider MUST join only through the normal Google Meet admission flow.
- The provider MUST record visible Ravi participant identity and admission
  status.
- Finalization MUST return normalized metadata, participants, transcript
  segments, media refs, and diagnostics.
- Normalized source/events MUST identify `channel=meet` and
  `provider=google-meet`.
- Provider output MUST NOT contain AI-generated summaries, decisions, or action
  items.
- `bun test src/meetings/google-meet/recorder-run.test.ts` SHOULD pass after
  changing provider behavior.
