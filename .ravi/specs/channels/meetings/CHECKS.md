# Meeting Channels / CHECKS

## Checks

- A meeting session MUST include provider, origin session/agent metadata,
  timestamps, participants, transcript segments, media refs, artifact id, and
  raw provenance when available.
- Transcript segments MUST include speaker label or unresolved id, timestamp,
  raw text, and capture/source provenance.
- Media refs SHOULD include kind, URI/path/artifact id, mime/size when
  available, and capture provenance.
- Provider adapters MUST identify as provider implementations under
  `channel=meet`, not as separate semantic channels.
- `bun test src/channels/meetings/types.test.ts src/meetings/profiles.test.ts src/meetings/resolved-profile.test.ts`
  SHOULD pass after changing meeting channel contracts.
