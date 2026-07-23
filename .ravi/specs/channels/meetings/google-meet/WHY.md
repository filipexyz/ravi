# Google Meet Provider / WHY

Google Meet is the first provider proving the native `meet` channel contract.
It must join as an explicit Ravi participant, capture raw transcript/media
provenance, leave cleanly, and return normalized data for artifact generation.

Keeping `google-meet` as a provider id prevents provider-specific behavior from
leaking into sessions, observers, triggers, permissions, and delivery as a
separate Ravi channel.
