# Transcribe agent-first CLI contract / WHY

Transcription looks like a read ("just tell me what the audio says") and its
CommandAccess is even declared `kind: read` — but every call ships the audio
bytes to OpenAI Whisper and bills per minute. That mismatch between how the op
FEELS and what it COSTS is exactly why it got the money brake: agents casually
transcribe long recordings while exploring, and a one-hour file is a real
charge. The plan makes the cost visible through `sizeMB` before any byte leaves
the machine.

The domain has no free fallback (unlike video's subtitles path), so the brake
is unconditional. Validation order matters more than usual here: the extension
check passes for nonexistent paths, so the explicit `FILE_NOT_FOUND` gate must
run before the brake AND before the `statSync` that feeds the plan — otherwise
a typo in the path either produces a plausible-looking dry-run plan or an
uncaught ENOENT.

Daemon-side transcription of inbound voice messages goes through the service
layer directly and is deliberately outside this contract — braking it would
break the message flow that users already rely on.

No skill teaches this domain today; the gap is registered in the SPEC so the
skill wave can close it.
