---
id: channels/meetings/native-channel
mode: checks
---

# Checks

## Static Checks

- `channel=meet` appears only as the Ravi semantic channel id; provider ids such as `google-meet` remain provider metadata.
- Generic runtime code does not branch on `google-meet`.
- Provider internals do not create observer prompts directly.
- Tool allowlists reject `all` and `*` for live meeting tools.
- Meeting artifacts do not include credentials, cookies, browser profile secrets, or API keys.

## Test Targets

```bash
bun test src/cli/commands/meetings.test.ts
bun test src/meetings/**/*.test.ts
bun test src/runtime/observation-plane.test.ts
bun test src/gateway-native-delivery.test.ts
bun run typecheck
```

## Acceptance Checks

- A Google Meet join creates a meeting source with channel metadata.
- Voice transcript commits carry meeting id, speaker/provenance, timestamps, and sequence when available.
- Text chat events have a normalized event contract even if provider ingestion is not fully implemented.
- Outbound speech is delivered through meeting delivery and appears in the artifact.
- Outbound text chat is separately gated from speech.
- Observer rules can match meeting-originated sessions without provider-specific hooks.
- `meet.md` remains raw and complete.
