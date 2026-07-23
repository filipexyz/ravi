# Meeting Channels / RUNBOOK

## Debug Flow

1. Read the active rules:
   `ravi specs get channels/meetings --mode rules --json`.
2. Resolve the meeting channel session, provider id, origin session key, origin
   agent id, title/url, start/end timestamps, and raw provider provenance.
3. Inspect normalized participants, transcript segments, media refs, lifecycle
   events, and artifact id.
4. Verify the meeting provider is an adapter under `channel=meet`; provider ids
   such as `google-meet` are not Ravi semantic channel ids.
5. Confirm the origin session receives the generated artifact after finalizing.

## Validation

```bash
bun test src/channels/meetings/types.test.ts src/meetings/profiles.test.ts src/meetings/resolved-profile.test.ts
```
