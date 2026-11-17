# Transcribe agent-first CLI contract / WHY

Transcription ships audio bytes to OpenAI Whisper and may be billed per minute,
but the CLI has neither a configured spending limit nor a reliable preflight
quote. A universal confirmation would therefore require two calls without a
policy decision to make. Since the operation has no external delivery or
destructive effect, it runs immediately.

Validation order still matters: the extension check passes for nonexistent
paths, so the explicit `FILE_NOT_FOUND` gate must run before the provider call.

Daemon-side transcription of inbound voice messages goes through the service
layer directly and remains behaviorally aligned with the immediate CLI path.

No skill teaches this domain today; the gap is registered in the SPEC so the
skill wave can close it.

Provider errors must survive internally because replacing them with a generic
transcription headline prevents recovery. Passing the whole object outward is
also unsafe: SDK errors may contain request headers and a body/PII serialized
inside their message. The global diagnostic allowlist and shared egress
redactor preserve the declared failure reason without exposing those fields.
The constructor requires the diagnostic explicitly; logger and trace output
use the same rule rather than retaining a raw private stack dump.
