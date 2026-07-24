# Session Actions Checks

- [ ] A headless session MUST return zero recent mutable messages.
- [ ] Empty `chatIds` MUST fail closed.
- [ ] Two sessions using the same agent MUST NOT mutate each other's outbound
      messages.
- [ ] Two attached channel types MUST expose independent availability.
- [ ] Slack MUST NOT advertise stickers.
- [ ] A planned reply MUST NOT expose a runnable command.
- [ ] Edit/delete lookup MUST match discovery scope.
- [ ] New outbound persistence MUST include the stable origin session key.
- [ ] Legacy unscoped rows MUST NOT be offered as mutable targets.
- [ ] CLI tool context MUST preserve source instance and canonical chat ids.
