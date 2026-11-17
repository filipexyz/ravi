import * as sessions from "../router/sessions.js";
import type { SessionEntry } from "../router/types.js";
import { isBridgeSession, isBridgeSessionRef } from "../bridge/isolation.js";
import { consoleSessionTarget, currentConsoleInvocation } from "../sdk/gateway/console-context.js";

// Generic CLI/SDK session tools are not an alternate authority for private
// humans. Even local administrator capabilities cannot substitute a delegation.
function visible(session: SessionEntry | null): SessionEntry | null {
  if (currentConsoleInvocation()) return session && consoleSessionTarget(session.sessionKey) ? session : null;
  return session && !isBridgeSession(session) ? session : null;
}

export function isBridgeSessionTarget(ref: string): boolean {
  if (consoleSessionTarget(ref)) return false;
  if (isBridgeSessionRef(ref)) return true;
  const session = sessions.resolveSession(ref) ?? sessions.findSessionByChatId(ref);
  return Boolean(session && isBridgeSession(session));
}

export function resolveSession(ref: string): SessionEntry | null {
  if (currentConsoleInvocation()) {
    const key = consoleSessionTarget(ref);
    return key ? sessions.getSession(key) : null;
  }
  return isBridgeSessionRef(ref) ? null : visible(sessions.resolveSession(ref));
}

export function getSession(key: string): SessionEntry | null {
  return visible(sessions.getSession(key));
}

export function findSessionByChatId(chatId: string): SessionEntry | null {
  return visible(sessions.findSessionByChatId(chatId));
}

export function listSessions(): SessionEntry[] {
  return sessions.listSessions().filter((session) => !isBridgeSession(session));
}

export function getSessionsByAgent(agentId: string): SessionEntry[] {
  return sessions.getSessionsByAgent(agentId).filter((session) => !isBridgeSession(session));
}
