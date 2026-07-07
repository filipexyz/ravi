# Channels Checks

- [ ] Native adapters MUST route inbound events only when a Ravi channel
      instance/account is explicit.
- [ ] Missing route account MUST NOT fall back to cross-account route matching.
- [ ] Provider ids MUST be stored as provenance and MUST NOT replace Ravi chat,
      thread, actor, route or session ids in product-facing contracts.
- [ ] Channel credentials MUST be resolved through the credential broker/manager
      unless an explicit local smoke-test fallback is enabled.
- [ ] Env vars MUST NOT introduce persistent channel identity, connection
      identity or instance ownership.
- [ ] Feature code SHOULD depend on normalized Ravi channel concepts before raw
      provider payloads.
