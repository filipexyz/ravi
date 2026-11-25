/**
 * The key the spec host server is registered under in a session's
 * `mcpServers` (see `spec/server.ts`). Kept in a module of its own so that
 * light modules (the tool watchdog, the MCP name grammar) can read the host
 * server names without loading the Agent SDK.
 */
export const SPEC_MCP_SERVER_NAME = "spec";
