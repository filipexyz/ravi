/**
 * The daemon's MCP gateway, as a reference anyone can read without loading
 * the gateway itself (and the MCP client it brings). `gateway.ts` sets it
 * when the daemon starts the gateway; outside the daemon it stays null. The
 * Claude facade reads it here, so building a Claude runtime request in a CLI
 * process loads no MCP client.
 */

import type { McpGateway } from "./gateway.js";

/** The longest a call may run inline (the Claude facade's budget). */
export const MCP_MAX_CALL_BUDGET_MS = 240_000;

let daemonGateway: McpGateway | null = null;

/** The gateway the daemon started, or null outside the daemon. */
export function getMcpGateway(): McpGateway | null {
  return daemonGateway;
}

/** Set by `startMcpGateway` and `stopMcpGateway` only. */
export function setMcpGatewayInstance(gateway: McpGateway | null): void {
  daemonGateway = gateway;
}
