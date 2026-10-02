# Voice Sessions / CHECKS

- Starting a voice call MUST NOT change the parent Ravi session key or name.
- A second `start` for the same `(session_key, chat_id, client_kind)` MUST
  return the existing voice session (idempotent retry) or fail with
  `VOICE_SESSION_ALREADY_ACTIVE`.
- `voice_session_events` MUST be append-only with a monotonic `seq` per voice
  session, and the transcript MUST be recoverable in order.
- Ending a voice session MUST NOT delete the parent Ravi session or detach chat
  subscriptions.
- Transcript events MUST NOT be sent as channel messages without an explicit
  send/summarize action.
- Provider secrets MUST NOT be stored in `voice_profiles` or returned to the
  client; provider ids MUST appear only as redacted provenance.
