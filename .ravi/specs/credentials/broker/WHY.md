# Credential Broker Why

## Why A Broker Boundary

Provider actions need secrets, but agents and generic command callers should
not receive those secrets. A broker boundary lets Ravi perform the action while
controlling authorization, approval, audit and redaction in one place.

Without a broker, every provider integration would eventually learn how to read
Keychain/Vault directly. That spreads secret handling rules across the codebase
and makes leak prevention harder.

## Why Two Capabilities

Every brokered action requires both:

```text
use:credential:<provider>:<connection>
execute:<provider>:<action>
```

Reason:

- Credential access and provider action execution are different powers.
- An actor may be allowed to list Slack channels but not use the production
  Slack bot connection.
- An actor may be allowed to use a credential for one action but not destructive
  actions.

## Why Approval Before Secret Resolution

Sensitive actions request approval before resolving the secret.

Reason:

- Approval should cover intent before secret material enters process scope.
- Denied actions should never touch backend secret values.
- Audit can distinguish denied intent from failed provider execution.

## Why Provider Adapters

The broker should not contain Slack/Gmail/GitHub business logic.

Provider adapters keep action-specific code separate while still forcing all
secret resolution through the broker.

## Why Keep `broker exec`

`broker exec` is useful for:

- PoC validation.
- Smoke tests.
- First provider integrations.
- Debugging policy and approval behavior.

It is risky if treated as a generic secret read surface. The command must remain
an action execution path that returns redacted results only.

## Why Not Read Secrets Into CLI Output

Even local operators should not normalize workflows that print provider
secrets. Debugging should use:

- `policies explain`
- backend existence checks
- `secretResolved=true`
- provider-native `auth.check` style actions

## Keychain Tradeoff

The PoC uses macOS `security` CLI because it is available locally and validates
the shape quickly. Production should move to a native Security.framework
binding or helper process to avoid passing secrets as process arguments during
writes.

## Vault Tradeoff

Vault KV v2 read-merge-write preserves sibling keys. Production should add CAS
or version-aware writes to avoid lost updates when two writers modify the same
path concurrently.
