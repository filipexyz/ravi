---
id: channels/credentials
title: "Credenciais De Canais"
kind: capability
domain: channels
capabilities:
  - credentials
tags:
  - security
  - broker
status: active
normative: true
---

# Credenciais De Canais

## Invariantes

1. Channel credentials MUST NOT be stored in `runtime.credentials`.
2. Channel credentials MUST NOT be stored in `~/.ravi/credentials.json`, which is reserved for runtime context keys.
3. SQLite MAY store credential metadata, but MUST NOT store provider secret values.
4. Secret values MUST be resolved only by an internal broker/backend boundary.
5. CLI output MUST show redacted refs and metadata only.
6. Agents MUST receive connection ids/capabilities, not provider secrets.
7. A provider action MUST require both:
   - `use:credential:<provider>:<connection>`
   - `execute:<provider>:<action>`
8. The broker MUST support local Keychain and production Vault-compatible refs.
9. Env credentials MUST NOT be used by native channel runners or channel CLIs.
10. Channel configs are the authority for selecting channel credentials.
    Each native channel that needs provider credentials MUST store an explicit
    `credentialConnection` reference on its Ravi channel config.
11. The credential provider is inferred from the channel config provider
    (`slack`, `whatsapp`, etc.); channel configuration stores only the
    connection id.
12. Ravi MUST NOT infer a credential connection from channel names and MUST
    NOT use provider-specific JSON such as `slackCredentialConnection` or
    `credentials.slackConnection` in channel defaults.

## Slack Secret Shape

For the first native Slack implementation, a Slack connection secret SHOULD be a JSON object:

```json
{
  "appToken": "xapp-...",
  "botToken": "xoxb-..."
}
```

The broker MAY also accept env-like text as the stored secret value for local
migration:

```text
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
```

The raw value MUST never be printed.
