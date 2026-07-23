# A2A Authorization / CHECKS

## Checks

- `ravi specs get a2a/auth --mode rules --json` MUST return the Ravi-owned
  policy layer above Agent Card metadata.
- Credential selection MUST come from an active auth binding; a model prompt
  MUST NOT select or paste credential refs.
- `card_json`, `auth_context_json`, logs, and prompt hints MUST NOT contain
  bearer tokens, API keys, or raw credential values.
- Remote task enumeration without a scoped `contextId` or tenant boundary MUST
  fail closed.
- Push callback URL validation MUST reject private-network and loopback targets.
