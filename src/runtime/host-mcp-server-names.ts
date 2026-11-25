import { SPEC_MCP_SERVER_NAME } from "../spec/server-name.js";

/**
 * Every name Ravi registers an in-process host MCP server under. These names
 * are reserved in the MCP registry (spec mcp, Names), so a registered remote
 * server can never take a host server's name or its tool-name prefix. A new
 * host server is added here in the same change that attaches it
 * (`runtime-host-attachments.ts` re-exports this list).
 */
export const HOST_MCP_SERVER_NAMES: readonly string[] = Object.freeze([SPEC_MCP_SERVER_NAME]);

/** True for a tool name under the `mcp__<host>__` prefix of a host server. */
export function isHostMcpToolName(toolName: string | undefined): boolean {
  if (typeof toolName !== "string") return false;
  return HOST_MCP_SERVER_NAMES.some((name) => toolName.startsWith(`mcp__${name}__`));
}
