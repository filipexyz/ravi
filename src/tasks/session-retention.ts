import { parseDurationMs } from "../cron/schedule.js";
import { dbGetSetting } from "../router/router-db.js";
import { setSessionEphemeral } from "../router/sessions.js";
import { logger } from "../utils/logger.js";

export const TASK_SESSION_TTL_SETTING = "tasks.sessionTtl";
export const DEFAULT_TASK_SESSION_TTL = "1d";
export const KNOWLEDGE_ENGINEER_TASK_SESSION_TTL_SETTING = "tasks.sessionTtl.knowledgeEngineer";
export const DEFAULT_KNOWLEDGE_ENGINEER_TASK_SESSION_TTL = "5m";

const log = logger.child("tasks:session-retention");

function parseTaskSessionTtlSetting(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (!normalized || ["off", "false", "disabled", "none", "0"].includes(normalized)) return null;
  return parseDurationMs(normalized);
}

export function isKnowledgeEngineerAgent(agentId?: string | null): boolean {
  return typeof agentId === "string" && agentId.startsWith("knowledge-engineer-");
}

export function isTaskRuntimeSessionName(sessionName?: string | null): boolean {
  if (!sessionName) return false;
  return /^task-[A-Za-z0-9_-]+-work(?:$|[:/])/.test(sessionName) || sessionName.endsWith("-work");
}

export function shouldRefreshTaskSessionTtlOnTurnComplete(input: {
  sessionName?: string | null;
  taskBarrierTaskId?: string | null;
}): boolean {
  return Boolean(input.taskBarrierTaskId) || isTaskRuntimeSessionName(input.sessionName);
}

export function resolveTaskSessionTtlMs(agentId?: string | null): number | null {
  if (isKnowledgeEngineerAgent(agentId)) {
    const configured =
      dbGetSetting(KNOWLEDGE_ENGINEER_TASK_SESSION_TTL_SETTING)?.trim() ?? DEFAULT_KNOWLEDGE_ENGINEER_TASK_SESSION_TTL;
    return parseTaskSessionTtlSetting(configured);
  }

  const configured = dbGetSetting(TASK_SESSION_TTL_SETTING)?.trim() ?? DEFAULT_TASK_SESSION_TTL;
  return parseTaskSessionTtlSetting(configured);
}

export function applyTaskSessionTtlForAgent(
  session: { sessionKey: string; name?: string | null },
  agentId?: string | null,
  options: { source?: string } = {},
): void {
  const ttlMs = resolveTaskSessionTtlMs(agentId);
  if (ttlMs === null) return;
  setSessionEphemeral(session.sessionKey, ttlMs);
  log.debug("Applied task session TTL", {
    sessionName: session.name ?? session.sessionKey,
    agentId,
    ttlMs,
    setting: isKnowledgeEngineerAgent(agentId) ? KNOWLEDGE_ENGINEER_TASK_SESSION_TTL_SETTING : TASK_SESSION_TTL_SETTING,
    source: options.source,
  });
}
