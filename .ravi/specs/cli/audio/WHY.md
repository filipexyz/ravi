# Audio agent-first CLI contract / WHY

TTS is billed per character, but this CLI has neither a configured spending
limit nor a reliable preflight quote. An unconditional second call therefore
adds friction without making a cost-based decision. Pure `audio generate`
runs immediately. The brake follows observable risk instead: `--send` delivers
to a live chat, while `audio tts` publishes work that triggers downstream
generation and playback.

When confirmation is required, the plan shows resolved scalar generation
facts, `textChars` and presence metadata. User text, captions, output paths,
destination ids and arbitrary nested voice options are excluded entirely;
even a bounded preview or identifier can expose a token or personal datum.
These facts are useful context but are not presented as a monetary estimate.

`audio blob` remains binary on success so playback is unchanged. Failure is
different: a 4xx/5xx `Response` is normalized to the shared contract instead
of becoming exit 0 or exposing a provider body. `voices`/`pending` got only
`--fields`, the read-side half of the contract.

One scope note: daemon automations emit `ravi.tts` directly through the service
layer, so the CLI's triggered-execution brake does not govern those emissions.
The CLI brake on `audio tts` exists because it queues downstream work and
playback, not merely because the provider may charge without a threshold.
