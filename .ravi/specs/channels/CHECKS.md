# Channels / CHECKS

## Transport Boundary

- Ravi MUST own operational behavior (routing, presence lifecycle, task notifications, runtime-originated outbound intent).
- Transport adapters MUST only deliver channel-specific payloads and report delivery state.
- Ravi MUST NOT patch transport code to compensate for broken runtime lifecycle or routing rules without evidence that the transport contract is wrong.

## Identity Abstraction

- Omni/raw channel identifiers MUST remain stored as provenance and debugging data.
- Raw provider ids MUST NOT be the primary product model exposed to agents or operators.
- Product and agent-facing code SHOULD work with Ravi concepts (contact, platform identity, chat, session, actor, message, route, policy).

## Capability Exposure

- Channel-specific behavior SHOULD be exposed through typed capabilities and normalized events.
- Provider conditionals MUST NOT be spread across features.

## Credential Dependency

- Channels that require provider/action secrets MUST depend on the credentials broker for secret resolution.
- Channel runners MUST NOT read Keychain, Vault, or other secret backends directly.

## Validation Commands

```bash
ravi specs get channels --mode full --json
bun run typecheck
bun run build
```
