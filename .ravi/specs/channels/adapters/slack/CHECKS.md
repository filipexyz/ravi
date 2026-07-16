# Slack Adapter Checks

- [ ] Inbound channel message MUST persist chat, message and participant records.
- [ ] Thread reply MUST include the Slack thread target.
- [ ] Outbound response MUST use Slack native delivery.
- [ ] Bot and self messages MUST be ignored.
- [ ] Missing credentials MUST disable the adapter.
- [ ] Env fallback MUST be opt-in.
- [ ] Tests MUST cover routing policy and native delivery.
- [ ] An identity stored under the configured UUID MUST resolve when inbound Slack uses the account slug for that same instance.
- [ ] An identity stored under the configured slug MUST resolve when inbound Slack uses the configured UUID for that same instance.
- [ ] The same Slack user id in another workspace MUST NOT be selected.
- [ ] The empty legacy scope MUST be consulted only after scoped alias misses and MUST NOT act as a wildcard.
- [ ] Conflicting owners across equivalent aliases MUST fail closed with `ambiguous_instance_alias`, no actor, and zero capabilities.
- [ ] Resolution provenance MUST carry the received alias, canonical instance reference, matched scope, and reason code using concrete schemas.
- [ ] New writes MUST use the canonical instance reference and stay duplicate-free across retries.
