import type {
  ChannelTurnAction,
  ChannelTurnOriginMetadata,
  RuntimeTurnOriginPrincipal,
  RuntimeTurnOriginMetadata,
  SessionRelayAction,
  SessionRelayTurnOriginMetadata,
} from "./message-types.js";

export const RUNTIME_TURN_ORIGIN_PROTOCOL = "ravi.runtime.turn-origin" as const;
export const RUNTIME_TURN_ORIGIN_SCHEMA_VERSION = 1 as const;

const SESSION_RELAY_ACTIONS = new Set<SessionRelayAction>(["send", "ask", "answer", "execute", "inform"]);
const CHANNEL_TURN_ACTIONS = new Set<ChannelTurnAction>(["session.bootstrap", "session.return"]);

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
    principal: buildRuntimeCallerPrincipal({ agentId, sessionKey, sessionName }),
    ...(session ? { session } : {}),
  };
}

export function buildRuntimeCallerPrincipal(
  context?: SessionRelayOriginContext,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeTurnOriginPrincipal {
  // A process the daemon spawned for an automation acts for that automation,
  // never for the local operator, even when it falls back to the operator's
  // default credential.
  const spawned = readSpawnedAutomationPrincipal(env);
  if (spawned) return { type: "automation", id: spawned.slice("automation:".length) };
  const agentId = cleanString(context?.agentId);
  if (agentId) return { type: "agent", id: agentId };
  const sessionKey = cleanString(context?.sessionKey);
  return { type: "automation", id: sessionKey ? `session:${sessionKey}` : "operator:local" };
}

/**
 * Set by the daemon on every process it spawns for an automation (shell cron,
 * shell trigger, job): `automation:<kind>:<id>`. Those processes run without a
 * runtime context, so without it they would look like the operator's terminal.
 */
export const RAVI_AUTOMATION_PRINCIPAL_ENV = "RAVI_AUTOMATION_PRINCIPAL";

export type SpawnedAutomationKind = "cron" | "trigger" | "job";

const SPAWNED_AUTOMATION_PRINCIPAL_PATTERN = /^automation:(?:cron|trigger|job):[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;

export function spawnedAutomationEnv(kind: SpawnedAutomationKind, id: string): Record<string, string> {
  return { [RAVI_AUTOMATION_PRINCIPAL_ENV]: `automation:${kind}:${id}` };
}

/** The automation a daemon-spawned process acts for, or null outside one (or when the marker is malformed). */
export function readSpawnedAutomationPrincipal(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[RAVI_AUTOMATION_PRINCIPAL_ENV]?.trim();
  return value && SPAWNED_AUTOMATION_PRINCIPAL_PATTERN.test(value) ? value : null;
}

export function buildChannelTurnOrigin(
  action: ChannelTurnAction,
  principal: RuntimeTurnOriginPrincipal,
): ChannelTurnOriginMetadata {
  if (!isChannelTurnAction(action)) throw new Error(`Unsupported channel turn action: ${action}`);
  const resolvedPrincipal = resolvePrincipal(principal);
  if (!resolvedPrincipal) throw new Error("Channel turn origin requires a valid principal");
  return {
    protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
    schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
    producer: "channel",
    action,
    principal: resolvedPrincipal,
  };
}

/**
 * Validate the wire envelope before it can affect authority or turn
 * classification. Extra fields are intentionally discarded. This validates
 * shape, not producer identity: authenticity comes from restricting the
 * internal session-prompt bus to trusted Ravi producers.
 */
export function isSessionRelayTurn(prompt: { _turnOrigin?: unknown } | null | undefined): boolean {
  return resolveRuntimeTurnOrigin(prompt?._turnOrigin)?.producer === "session-relay";
}

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

  if (value.producer === "channel" && isChannelTurnAction(value.action)) {
    return {
      protocol: RUNTIME_TURN_ORIGIN_PROTOCOL,
      schemaVersion: RUNTIME_TURN_ORIGIN_SCHEMA_VERSION,
      producer: "channel",
      action: value.action,
      principal,
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

function isChannelTurnAction(value: unknown): value is ChannelTurnAction {
  return typeof value === "string" && CHANNEL_TURN_ACTIONS.has(value as ChannelTurnAction);
}

function cleanString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
