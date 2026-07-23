# Channel Mentions / RUNBOOK

## Debug Flow

1. Read the contract:
   `ravi specs get channels/mentions --mode rules --json`.
2. Resolve the output chat independently from the source chat.
3. Resolve requested mentions through chat participants, platform identities,
   contacts, or agent identities. Do not ask the model to type provider ids.
4. Inspect outbound payload metadata for mention ids and safe display labels.
5. For inbound rendering, ensure raw provider ids stay in provenance/debug data
   and are not presented as names.

## Validation

```bash
bun test src/omni/mentions.test.ts src/omni/sender.test.ts src/omni/group-metadata-cache.test.ts src/gateway-session-trace.test.ts src/cli/commands/channels-json.test.ts
bun run typecheck
bun run build
```
