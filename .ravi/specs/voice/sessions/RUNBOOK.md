# Voice Sessions / RUNBOOK

## Debug Flow

1. Read the rules: `ravi specs get voice/sessions --mode rules --json`.
2. For a failed `start`, check each validation in order: the Ravi session is
   visible, the agent owns it, the chat exists (or is omitted), the profile is
   enabled, the transport is healthy, and no non-terminal voice session holds
   the same `(session_key, chat_id, client_kind)`.
3. For a call that stopped mid-way, read its `voice_session_events` in `seq`
   order and look for the sideband-loss or interruption event.
4. For a tool problem, follow `voice.tool.requested` → `voice.tool.started` →
   `voice.tool.completed` and check whether the result was dropped because the
   session was already interrupted or terminal.
5. If a transcript reached a chat, find the explicit send/summarize action that
   delivered it; transcripts are never delivered on their own.
