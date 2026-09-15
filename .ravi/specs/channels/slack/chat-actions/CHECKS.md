# Slack Chat Actions Checks

- [ ] Slack edit calls `chat.update`.
- [ ] Slack delete calls `chat.delete`.
- [ ] Slack reaction calls `reactions.add` or `reactions.remove`.
- [ ] No native Slack action resolves an Omni instance.
- [ ] Slack sticker availability is `unavailable/unsupported_channel`.
- [ ] Missing Slack credentials produce `missing_connection`.
- [ ] Missing provider scope remains an explicit terminal failure.
- [ ] Queue acceptance is reported as `queued`.
- [ ] Slack failure leaves the canonical message unchanged.
- [ ] Slack success updates canonical edit/delete state exactly once.
- [ ] Media upload returns success only after `files.completeUploadExternal`.
- [ ] Slack thread create calls root `chat.postMessage` with stable
      `client_msg_id`.
- [ ] Thread create delivery reports the root message `ts`.
- [ ] The channel runner does not create a session or publish its first prompt.
- [ ] Thread close performs no Slack mutation.
