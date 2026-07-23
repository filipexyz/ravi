# Channel Mentions / CHECKS

## Checks

- Outbound mention resolution MUST use Ravi chat participant and platform
  identity data, not raw ids supplied by an agent.
- Multi-chat sessions MUST resolve mentions against the output chat, not the
  inbound source chat unless they are the same canonical chat.
- Inbound mention rendering MUST preserve raw provider ids as provenance while
  showing safe display labels to runtime agents.
- Missing or ambiguous mention targets MUST fail safely instead of sending a
  mention to the wrong participant.
- `bun test src/omni/mentions.test.ts src/omni/sender.test.ts src/omni/group-metadata-cache.test.ts src/gateway-session-trace.test.ts src/cli/commands/channels-json.test.ts`
  SHOULD pass after changing mention behavior.
