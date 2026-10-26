import { getAgent } from "../router/config.js";
import { dbGetSetting, getDb } from "../router/router-db.js";
import { getMainSession, getSession, getSessionByName } from "../router/sessions.js";
import type { SignalRecord, SignalScopeType, SignalSessionContext } from "./types.js";

export interface TaskRuntimeSubject {
  id: string;
  status: string;
  archivedAt: number | null;
  progress: number;
  assigneeSessionName: string | null;
  assigneeAgentId: string | null;
  sessionExists: boolean;
  sessionEphemeral: boolean;
  sessionEnded: boolean;
  updatedAt: number;
}

export function readTaskRuntimeSubject(taskId: string, now = Date.now()): TaskRuntimeSubject | null {
  const row = getDb()
    .prepare(
      `SELECT id, status, archived_at, progress, assignee_session_name, assignee_agent_id, updated_at
       FROM tasks WHERE id = ?`,
    )
    .get(taskId) as
    | {
        id: string;
        status: string;
        archived_at: number | null;
        progress: number;
        assignee_session_name: string | null;
        assignee_agent_id: string | null;
        updated_at: number;
      }
    | undefined;
  if (!row) return null;
  const session = row.assignee_session_name
    ? (getDb()
        .prepare("SELECT ephemeral, expires_at FROM sessions WHERE name = ? OR session_key = ? LIMIT 1")
        .get(row.assignee_session_name, row.assignee_session_name) as
        | { ephemeral: number; expires_at: number | null }
        | undefined)
    : undefined;
  return {
    id: row.id,
    status: row.status,
    archivedAt: row.archived_at,
    progress: Number(row.progress),
    assigneeSessionName: row.assignee_session_name,
    assigneeAgentId: row.assignee_agent_id,
    sessionExists: Boolean(session),
    sessionEphemeral: session?.ephemeral === 1,
    sessionEnded: Boolean(
      session && session.ephemeral === 1 && session.expires_at !== null && session.expires_at <= now,
    ),
    updatedAt: Number(row.updated_at),
  };
}

export function taskSubjectIsTerminal(task: TaskRuntimeSubject): boolean {
  return (
    task.archivedAt !== null ||
    task.status === "done" ||
    task.status === "failed" ||
    task.status === "archived" ||
    (task.sessionEphemeral && task.sessionEnded)
  );
}

export function isSubjectTerminal(
  subjectType: string | undefined,
  subjectId: string | undefined,
  now = Date.now(),
): boolean {
  if (!subjectType || !subjectId) return false;
  switch (subjectType) {
    case "task": {
      const task = readTaskRuntimeSubject(subjectId, now);
      return !task || taskSubjectIsTerminal(task);
    }
    case "session": {
      const session = getSessionByName(subjectId) ?? getSessionByName(subjectId.replace(/:.*$/, ""));
      if (!session) return true;
      return Boolean(session.ephemeral && session.expiresAt != null && session.expiresAt <= now);
    }
    case "agent":
      return !getAgent(subjectId);
    case "contact":
    case "project":
      return false;
    default:
      return false;
  }
}

export function resolveFleetSessionName(): string {
  const configured = dbGetSetting("signals.fleet_session")?.trim();
  if (configured) return configured;
  const agentId = process.env.RAVI_AGENT_ID?.trim() || dbGetSetting("defaultAgent")?.trim() || "main";
  return getMainSession(agentId)?.name ?? agentId;
}

export function resolveScopeSessionNames(scopeType: SignalScopeType, scopeId: string): string[] {
  switch (scopeType) {
    case "fleet":
      return [resolveFleetSessionName()];
    case "agent": {
      const main = getMainSession(scopeId);
      return main?.name ? [main.name] : [];
    }
    case "chat": {
      const rows = getDb()
        .prepare(
          `SELECT DISTINCT s.name AS name
           FROM session_chat_subscriptions sub
           JOIN sessions s ON s.session_key = sub.session_key
           WHERE sub.chat_id = ? AND sub.detached_at IS NULL AND s.name IS NOT NULL`,
        )
        .all(scopeId) as Array<{ name: string }>;
      return rows.map((row) => row.name);
    }
    case "person": {
      const rows = getDb()
        .prepare(
          `SELECT DISTINCT s.name AS name
           FROM chat_participants p
           JOIN chats c ON c.id = p.chat_id
           JOIN session_chat_subscriptions sub ON sub.chat_id = c.id AND sub.detached_at IS NULL
           JOIN sessions s ON s.session_key = sub.session_key
           WHERE p.contact_id = ? AND c.chat_type = 'dm' AND s.name IS NOT NULL`,
        )
        .all(scopeId) as Array<{ name: string }>;
      return rows.map((row) => row.name);
    }
    case "project": {
      const rows = getDb()
        .prepare(
          `SELECT DISTINCT s.name AS name
           FROM session_goals g
           JOIN sessions s ON s.session_key = g.session_key
           WHERE g.project_id = ? AND s.name IS NOT NULL`,
        )
        .all(scopeId) as Array<{ name: string }>;
      return rows.map((row) => row.name);
    }
  }
}

export function resolveSignalTargetSessions(signal: SignalRecord): string[] {
  if (signal.targetSessions && signal.targetSessions.length > 0) {
    return signal.targetSessions;
  }
  return resolveScopeSessionNames(signal.scopeType, signal.scopeId);
}

export function readSessionSignalContext(sessionName: string): SignalSessionContext {
  const session = getSessionByName(sessionName) ?? getSession(sessionName);
  if (!session) {
    return { sessionName };
  }
  const chatRow = getDb()
    .prepare(
      `SELECT chat_id FROM session_chat_subscriptions
       WHERE session_key = ? AND detached_at IS NULL
       ORDER BY CASE role WHEN 'primary' THEN 0 WHEN 'input' THEN 1 ELSE 2 END, id
       LIMIT 1`,
    )
    .get(session.sessionKey) as { chat_id: string } | undefined;
  const chatId = chatRow?.chat_id;
  const contactRows = chatId
    ? (getDb()
        .prepare("SELECT DISTINCT contact_id FROM chat_participants WHERE chat_id = ? AND contact_id IS NOT NULL")
        .all(chatId) as Array<{ contact_id: string }>)
    : [];
  const projectRow = getDb()
    .prepare("SELECT project_id FROM session_goals WHERE session_key = ? AND status = 'active' LIMIT 1")
    .get(session.sessionKey) as { project_id: string | null } | undefined;
  return {
    sessionName,
    sessionKey: session.sessionKey,
    agentId: session.agentId,
    chatId,
    contactIds: contactRows.map((row) => row.contact_id),
    projectId: projectRow?.project_id ?? undefined,
  };
}

export function signalIsInSessionScope(signal: SignalRecord, context: SignalSessionContext): boolean {
  if (signal.targetSessions && signal.targetSessions.length > 0) {
    return signal.targetSessions.includes(context.sessionName);
  }
  switch (signal.scopeType) {
    case "fleet":
      return context.sessionName === resolveFleetSessionName();
    case "agent":
      return Boolean(context.agentId && context.agentId === signal.scopeId);
    case "chat":
      return Boolean(context.chatId && context.chatId === signal.scopeId);
    case "person":
      return Boolean(context.contactIds?.includes(signal.scopeId));
    case "project":
      return Boolean(context.projectId && context.projectId === signal.scopeId);
  }
}
