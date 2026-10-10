/**
 * Per-agent use of connected accounts.
 *
 * Each agent has one mode per provider, stored in the settings table under
 * `connectors.mode.<agentId>.<provider>`:
 *
 *   owner          "Only when I ask" (default, also what a missing or unknown
 *                  value means): the operator's own connection, for the
 *                  operator's own turns only.
 *   person_asking  "The person asking": a contact uses their own connection
 *                  through `POST /cli/agent-exec`, after allowing the agent
 *                  once in the Console.
 *   shared         "Shared account": the organization account an admin
 *                  shared with this agent in the Console.
 *
 * Only the operator changes a mode (`ravi connectors mode`), and only
 * `ravi connectors mode` writes these keys: `ravi settings set` refuses them,
 * so the write brake on expanding a mode cannot be skipped.
 */

import { dbDeleteSetting, dbGetSetting, dbSetSetting } from "../router/router-db.js";

export type ConnectorUseMode = "owner" | "person_asking" | "shared";
export type ConnectorAgentMode = Exclude<ConnectorUseMode, "owner">;

export const CONNECTOR_MODE_SETTING_PREFIX = "connectors.mode.";
/** Providers that have a mode. */
export const CONNECTOR_MODE_PROVIDERS = ["google"] as const;
/** Mode values as the CLI spells them. */
export const CONNECTOR_MODE_ARGS = ["owner", "person-asking", "shared"] as const;

export function connectorModeSettingKey(agentId: string, provider: string): string {
  return `${CONNECTOR_MODE_SETTING_PREFIX}${agentId}.${provider}`;
}

export function isConnectorModeSettingKey(key: string): boolean {
  return key.startsWith(CONNECTOR_MODE_SETTING_PREFIX);
}

export function isConnectorModeProvider(provider: string): boolean {
  return (CONNECTOR_MODE_PROVIDERS as readonly string[]).includes(provider);
}

/** `owner`, `person-asking` (or `person_asking`) and `shared`; anything else is null. */
export function parseConnectorModeArg(value: string): ConnectorUseMode | null {
  const normalized = value.trim().toLowerCase().replace(/-/g, "_");
  return normalized === "owner" || normalized === "person_asking" || normalized === "shared" ? normalized : null;
}

export function connectorModeArg(mode: ConnectorUseMode): (typeof CONNECTOR_MODE_ARGS)[number] {
  return mode === "person_asking" ? "person-asking" : mode;
}

export function connectorModeLabel(mode: ConnectorUseMode): string {
  switch (mode) {
    case "owner":
      return "Only when I ask";
    case "person_asking":
      return "The person asking";
    case "shared":
      return "Shared account";
  }
}

/** The stored mode; a missing, unreadable or unknown value is `owner`, the narrowest one. */
export function readAgentConnectorMode(
  agentId: string,
  provider: string,
  read: (key: string) => string | null = dbGetSetting,
): ConnectorUseMode {
  let stored: string | null;
  try {
    stored = read(connectorModeSettingKey(agentId, provider));
  } catch {
    return "owner";
  }
  return stored ? (parseConnectorModeArg(stored) ?? "owner") : "owner";
}

/** `owner` removes the key (the default); the other modes store their value. */
export function writeAgentConnectorMode(agentId: string, provider: string, mode: ConnectorUseMode): void {
  const key = connectorModeSettingKey(agentId, provider);
  if (mode === "owner") {
    dbDeleteSetting(key);
    return;
  }
  dbSetSetting(key, mode);
}
