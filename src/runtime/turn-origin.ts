import type {
  RuntimeTurnOriginMetadata,
  SessionRelayAction,
  SessionRelayTurnOriginMetadata,
  SystemTurnOriginMetadata,
} from "./message-types.js";

export const RUNTIME_TURN_ORIGIN_PROTOCOL = "ravi.runtime.turn-origin" as const;
export const RUNTIME_TURN_ORIGIN_SCHEMA_VERSION = 1 as const;

const SESSION_RELAY_ACTIONS = new Set<SessionRelayAction>(["send", "ask", "answer", "execute", "inform"]);

export interface SessionRelayOriginContext {
  agentId?: string;
  sessionKey?: string;
  sessionName?: string;
}

export function buildSessionRelayTurnOrigin(
  action: SessionRelayAction,
  context?: SessionRelayOriginContext,
): SessionRelayTurnOriginMetadata {
  const agentId = cleanString(context?.agentId);
  const sessionKey = cleanString(context?.sessionKey);
  const sessionName = cleanString(context?.sessionName);
  const session =
    sessionKey || sessionName
      ? { ...(sessionKey ? { key: sessionKey } : {}), ...(sessionName ? { name: sessionName } : {}) }
      : undefined;

  return {
    protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
    schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
    producer: "session-relay",
    action,
    principal: agentId
      ? { type: "agent", id: agentId }
      : { type: "automation", id: sessionKey ? `session:${sessionKey}` : "operator:local" },
    ...(session ? { session } : {}),
  };
}

export function buildSystemTurnOrigin(action: SystemTurnOriginMetadata["action"]): SystemTurnOriginMetadata {
  return {
    protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
    schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
    producer: "system",
    action,
    principal: {
      type: "automation",
      id: action,
    },
  };
}

/**
 * Validate the wire envelope before it can affect authority or turn
 * classification. Extra fields are intentionally discarded.
 */
export function resolveRuntimeTurnOrigin(value: unknown): RuntimeTurnOriginMetadata | null {
  if (!isRecord(value)) return null;
  if (value.protocol !== RUNTIME_TURN_ORIGIN_PROTOCOL || value.schemaVersion !== RUNTIME_TURN_ORIGIN_SCHEMA_VERSION) {
    return null;
  }

  const principal = resolvePrincipal(value.principal);
  if (!principal) return null;

  if (value.producer === "session-relay" && isSessionRelayAction(value.action)) {
    const session = resolveSession(value.session);
    return {
      protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
      schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
      producer: "session-relay",
      action: value.action,
      principal,
      ...(session ? { session } : {}),
    };
  }

  if (
    value.producer === "system" &&
    value.action === "whatsapp.group.create" &&
    principal.type === "automation" &&
    principal.id === "whatsapp.group.create"
  ) {
    return {
      protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
      schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
      producer: "system",
      action: "whatsapp.group.create",
      principal: {
        type: "automation",
        id: "whatsapp.group.create",
      },
    };
  }

  return null;
}

function resolvePrincipal(value: unknown): RuntimeTurnOriginMetadata["principal"] | null {
  if (!isRecord(value) || (value.type !== "agent" && value.type !== "automation")) return null;
  const id = cleanString(value.id);
  return id ? { type: value.type, id } : null;
}

function resolveSession(value: unknown): SessionRelayTurnOriginMetadata["session"] | undefined {
  if (!isRecord(value)) return undefined;
  const key = cleanString(value.key);
  const name = cleanString(value.name);
  if (!key && !name) return undefined;
  return {
    ...(key ? { key } : {}),
    ...(name ? { name } : {}),
  };
}

function isSessionRelayAction(value: unknown): value is SessionRelayAction {
  return typeof value === "string" && SESSION_RELAY_ACTIONS.has(value as SessionRelayAction);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
