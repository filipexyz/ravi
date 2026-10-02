# Voice Sessions / WHY

A live call is a child interaction of a Ravi session, not a new session. Tying
it to the parent session keeps one owner agent, one chat binding and one
history, so a call can be inspected after it ends without renaming, resetting
or forking anything.

Voice transcripts are conversation evidence. Sending them to a chat
automatically would turn every spoken turn into an outbound message, so
delivery stays an explicit action under channel delivery policy.

Provider ids and raw provider payloads change per transport (`openai-direct`,
`livekit`), so product logic reads canonical events and keeps provider data as
redacted provenance only.
