# Audio agent-first CLI contract / WHY

TTS is billed per character, and agents produce long texts casually — a pasted
report piped into `audio generate` is real money. Both paid entry points got
the brake: `generate` (direct ElevenLabs call) and `tts` (a NATS emit whose
only purpose is to trigger the same paid generation downstream). Braking the
emit and not just the direct call matters: an agent that learned `audio tts`
would otherwise have a free bypass around the `generate` brake.

The plan shows the RESOLVED voice/model/speed, not the flags as typed, because
resolution falls back through agent defaults — the agent may believe it is
using the cheap turbo model while the default says otherwise. The text preview
plus `textChars` puts the billing driver (length) in front of the caller.

`audio blob` is deliberately untouched: it is on the binary returns allowlist
and streams raw bytes to extension clients; wrapping it in JSON envelopes would
break playback. `voices`/`pending` got only `--fields`, the read-side half of
the contract.

One scope note: daemon automations emit `ravi.tts` directly through the service
layer, so the brake governs CLI-initiated spends only — the same boundary the
tasks domain drew for automation-driven dispatches.
