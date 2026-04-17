import { randomUUID } from "node:crypto";
import { getDb, getDbChanges, getRaviDbPath } from "../router/router-db.js";
import {
  TASK_AUTOMATION_EVENTS,
  TASK_REPORT_EVENTS,
  type TaskAutomation,
  type TaskAutomationEventType,
  type TaskAutomationInput,
  type TaskAutomationRun,
  type TaskAutomationRunStatus,
  type TaskReportEvent,
} from "./types.js";

interface TaskAutomationRow {
  id: string;
  name: string;
  enabled: number;
  event_types_json: string;
  filter: string | null;
  title_template: string;
  instructions_template: string;
  priority: string | null;
  profile_id: string | null;
  agent_id: string | null;
  session_name_template: string | null;
  checkpoint_interval_ms: number | null;
  report_to_session_name_template: string | null;
  report_events_json: string | null;
  profile_input_json: string | null;
  inherit_parent_task: number;
  inherit_worktree: number;
  inherit_checkpoint: number;
  inherit_report_to: number;
  inherit_report_events: number;
  fire_count: number;
  last_fired_at: number | null;
  created_at: number;
  updated_at: number;
}

interface TaskAutomationRunRow {
  id: number;
  automation_id: string;
  trigger_task_id: string;
  trigger_event_id: number;
  trigger_event_type: string;
  spawned_task_id: string | null;
  status: string;
  message: string | null;
  created_at: number;
  updated_at: number;
}

let schemaReady = false;
let schemaDbPath: string | null = null;

function normalizeAutomationEventTypes(
  eventTypes?: readonly TaskAutomationEventType[] | readonly string[] | null,
): TaskAutomationEventType[] {
  const allowed = new Set<string>(TASK_AUTOMATION_EVENTS);
  const normalized = [
    ...new Set((eventTypes ?? []).filter((event): event is TaskAutomationEventType => allowed.has(event))),
  ];
  return normalized.length > 0 ? normalized : ["task.done"];
}

function normalizeReportEvents(events?: readonly TaskReportEvent[] | readonly string[] | null): TaskReportEvent[] {
  const allowed = new Set<string>(TASK_REPORT_EVENTS);
  const normalized = [...new Set((events ?? []).filter((event): event is TaskReportEvent => allowed.has(event)))];
  return normalized.length > 0 ? normalized : ["done"];
}

function serializeAutomationEventTypes(
  eventTypes?: readonly TaskAutomationEventType[] | readonly string[] | null,
): string {
  return JSON.stringify(normalizeAutomationEventTypes(eventTypes));
}

function deserializeAutomationEventTypes(raw: string | null | undefined): TaskAutomationEventType[] {
  if (!raw?.trim()) {
    return normalizeAutomationEventTypes();
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeAutomationEventTypes(parsed);
    }
  } catch {
    // Fall back to CSV.
  }

  return normalizeAutomationEventTypes(raw.split(",").map((value) => value.trim()));
}

function serializeReportEvents(events?: readonly TaskReportEvent[] | readonly string[] | null): string | null {
  if (!events) return null;
  return JSON.stringify(normalizeReportEvents(events));
}

function deserializeReportEvents(raw: string | null | undefined): TaskReportEvent[] | undefined {
  if (!raw?.trim()) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return normalizeReportEvents(parsed);
    }
  } catch {
    // Fall back to CSV.
  }

  return normalizeReportEvents(raw.split(",").map((value) => value.trim()));
}

function serializeProfileInput(profileInput?: Record<string, string> | null): string | null {
  if (!profileInput || Object.keys(profileInput).length === 0) {
    return null;
  }
  return JSON.stringify(profileInput);
}

function deserializeProfileInput(raw: string | null | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (!parsed || typeof parsed !== "object") return undefined;
    const resolved: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      resolved[key] = String(value);
    }
    return Object.keys(resolved).length > 0 ? resolved : undefined;
  } catch {
    return undefined;
  }
}

function rowToTaskAutomation(row: TaskAutomationRow): TaskAutomation {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled === 1,
    eventTypes: deserializeAutomationEventTypes(row.event_types_json),
    ...(row.filter ? { filter: row.filter } : {}),
    titleTemplate: row.title_template,
    instructionsTemplate: row.instructions_template,
    ...(row.priority ? { priority: row.priority as TaskAutomation["priority"] } : {}),
    ...(row.profile_id ? { profileId: row.profile_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.session_name_template ? { sessionNameTemplate: row.session_name_template } : {}),
    ...(typeof row.checkpoint_interval_ms === "number" ? { checkpointIntervalMs: row.checkpoint_interval_ms } : {}),
    ...(row.report_to_session_name_template
      ? { reportToSessionNameTemplate: row.report_to_session_name_template }
      : {}),
    ...(deserializeReportEvents(row.report_events_json)
      ? { reportEvents: deserializeReportEvents(row.report_events_json) }
      : {}),
    ...(deserializeProfileInput(row.profile_input_json)
      ? { profileInput: deserializeProfileInput(row.profile_input_json) }
      : {}),
    inheritParentTask: row.inherit_parent_task === 1,
    inheritWorktree: row.inherit_worktree === 1,
    inheritCheckpoint: row.inherit_checkpoint === 1,
    inheritReportTo: row.inherit_report_to === 1,
    inheritReportEvents: row.inherit_report_events === 1,
    fireCount: row.fire_count,
    ...(typeof row.last_fired_at === "number" ? { lastFiredAt: row.last_fired_at } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function rowToTaskAutomationRun(row: TaskAutomationRunRow): TaskAutomationRun {
  return {
    id: row.id,
    automationId: row.automation_id,
    triggerTaskId: row.trigger_task_id,
    triggerEventId: row.trigger_event_id,
    triggerEventType: row.trigger_event_type as TaskAutomationEventType,
    ...(row.spawned_task_id ? { spawnedTaskId: row.spawned_task_id } : {}),
    status: row.status as TaskAutomationRunStatus,
    ...(row.message ? { message: row.message } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function ensureTaskAutomationSchema(): void {
  const currentDbPath = getRaviDbPath();
  if (schemaReady && schemaDbPath === currentDbPath) return;

  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS task_automations (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      event_types_json TEXT NOT NULL,
      filter TEXT,
      title_template TEXT NOT NULL,
      instructions_template TEXT NOT NULL,
      priority TEXT,
      profile_id TEXT,
      agent_id TEXT,
      session_name_template TEXT,
      checkpoint_interval_ms INTEGER,
      report_to_session_name_template TEXT,
      report_events_json TEXT,
      profile_input_json TEXT,
      inherit_parent_task INTEGER NOT NULL DEFAULT 1,
      inherit_worktree INTEGER NOT NULL DEFAULT 1,
      inherit_checkpoint INTEGER NOT NULL DEFAULT 1,
      inherit_report_to INTEGER NOT NULL DEFAULT 1,
      inherit_report_events INTEGER NOT NULL DEFAULT 1,
      fire_count INTEGER NOT NULL DEFAULT 0,
      last_fired_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS task_automation_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      automation_id TEXT NOT NULL,
      trigger_task_id TEXT NOT NULL,
      trigger_event_id INTEGER NOT NULL,
      trigger_event_type TEXT NOT NULL,
      spawned_task_id TEXT,
      status TEXT NOT NULL,
      message TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (automation_id) REFERENCES task_automations(id) ON DELETE CASCADE,
      UNIQUE (automation_id, trigger_event_id)
    );

    CREATE INDEX IF NOT EXISTS idx_task_automations_enabled ON task_automations(enabled, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_automation_runs_automation ON task_automation_runs(automation_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_task_automation_runs_trigger ON task_automation_runs(trigger_task_id, created_at DESC);
  `);

  schemaReady = true;
  schemaDbPath = currentDbPath;
}

export function dbCreateTaskAutomation(input: TaskAutomationInput): TaskAutomation {
  ensureTaskAutomationSchema();

  const db = getDb();
  const id = randomUUID().slice(0, 8);
  const now = Date.now();
  db.prepare(`
    INSERT INTO task_automations (
      id, name, enabled, event_types_json, filter, title_template, instructions_template,
      priority, profile_id, agent_id, session_name_template, checkpoint_interval_ms,
      report_to_session_name_template, report_events_json, profile_input_json,
      inherit_parent_task, inherit_worktree, inherit_checkpoint, inherit_report_to, inherit_report_events,
      fire_count, last_fired_at, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.name,
    input.enabled !== false ? 1 : 0,
    serializeAutomationEventTypes(input.eventTypes),
    input.filter ?? null,
    input.titleTemplate,
    input.instructionsTemplate,
    input.priority ?? null,
    input.profileId ?? null,
    input.agentId ?? null,
    input.sessionNameTemplate ?? null,
    input.checkpointIntervalMs ?? null,
    input.reportToSessionNameTemplate ?? null,
    serializeReportEvents(input.reportEvents),
    serializeProfileInput(input.profileInput),
    input.inheritParentTask === false ? 0 : 1,
    input.inheritWorktree === false ? 0 : 1,
    input.inheritCheckpoint === false ? 0 : 1,
    input.inheritReportTo === false ? 0 : 1,
    input.inheritReportEvents === false ? 0 : 1,
    0,
    null,
    now,
    now,
  );

  return dbGetTaskAutomation(id)!;
}

export function dbGetTaskAutomation(id: string): TaskAutomation | null {
  ensureTaskAutomationSchema();

  const row = getDb().prepare("SELECT * FROM task_automations WHERE id = ?").get(id) as TaskAutomationRow | undefined;
  return row ? rowToTaskAutomation(row) : null;
}

export function dbListTaskAutomations(opts?: { enabledOnly?: boolean }): TaskAutomation[] {
  ensureTaskAutomationSchema();

  const sql = opts?.enabledOnly
    ? "SELECT * FROM task_automations WHERE enabled = 1 ORDER BY created_at DESC"
    : "SELECT * FROM task_automations ORDER BY created_at DESC";
  const rows = getDb().prepare(sql).all() as TaskAutomationRow[];
  return rows.map(rowToTaskAutomation);
}

export function dbUpdateTaskAutomation(
  id: string,
  updates: Partial<TaskAutomationInput> & { enabled?: boolean },
): TaskAutomation {
  ensureTaskAutomationSchema();

  const existing = dbGetTaskAutomation(id);
  if (!existing) {
    throw new Error(`Task automation not found: ${id}`);
  }

  const fields: string[] = [];
  const values: Array<string | number | null> = [];
  if (updates.name !== undefined) {
    fields.push("name = ?");
    values.push(updates.name);
  }
  if (updates.enabled !== undefined) {
    fields.push("enabled = ?");
    values.push(updates.enabled ? 1 : 0);
  }
  if (updates.eventTypes !== undefined) {
    fields.push("event_types_json = ?");
    values.push(serializeAutomationEventTypes(updates.eventTypes));
  }
  if (updates.filter !== undefined) {
    fields.push("filter = ?");
    values.push(updates.filter ?? null);
  }
  if (updates.titleTemplate !== undefined) {
    fields.push("title_template = ?");
    values.push(updates.titleTemplate);
  }
  if (updates.instructionsTemplate !== undefined) {
    fields.push("instructions_template = ?");
    values.push(updates.instructionsTemplate);
  }
  if (updates.priority !== undefined) {
    fields.push("priority = ?");
    values.push(updates.priority ?? null);
  }
  if (updates.profileId !== undefined) {
    fields.push("profile_id = ?");
    values.push(updates.profileId ?? null);
  }
  if (updates.agentId !== undefined) {
    fields.push("agent_id = ?");
    values.push(updates.agentId ?? null);
  }
  if (updates.sessionNameTemplate !== undefined) {
    fields.push("session_name_template = ?");
    values.push(updates.sessionNameTemplate ?? null);
  }
  if (updates.checkpointIntervalMs !== undefined) {
    fields.push("checkpoint_interval_ms = ?");
    values.push(updates.checkpointIntervalMs ?? null);
  }
  if (updates.reportToSessionNameTemplate !== undefined) {
    fields.push("report_to_session_name_template = ?");
    values.push(updates.reportToSessionNameTemplate ?? null);
  }
  if (updates.reportEvents !== undefined) {
    fields.push("report_events_json = ?");
    values.push(serializeReportEvents(updates.reportEvents));
  }
  if (updates.profileInput !== undefined) {
    fields.push("profile_input_json = ?");
    values.push(serializeProfileInput(updates.profileInput));
  }
  if (updates.inheritParentTask !== undefined) {
    fields.push("inherit_parent_task = ?");
    values.push(updates.inheritParentTask ? 1 : 0);
  }
  if (updates.inheritWorktree !== undefined) {
    fields.push("inherit_worktree = ?");
    values.push(updates.inheritWorktree ? 1 : 0);
  }
  if (updates.inheritCheckpoint !== undefined) {
    fields.push("inherit_checkpoint = ?");
    values.push(updates.inheritCheckpoint ? 1 : 0);
  }
  if (updates.inheritReportTo !== undefined) {
    fields.push("inherit_report_to = ?");
    values.push(updates.inheritReportTo ? 1 : 0);
  }
  if (updates.inheritReportEvents !== undefined) {
    fields.push("inherit_report_events = ?");
    values.push(updates.inheritReportEvents ? 1 : 0);
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push("updated_at = ?");
  values.push(Date.now());
  values.push(id);
  getDb()
    .prepare(`UPDATE task_automations SET ${fields.join(", ")} WHERE id = ?`)
    .run(...values);
  return dbGetTaskAutomation(id)!;
}

export function dbDeleteTaskAutomation(id: string): boolean {
  ensureTaskAutomationSchema();
  getDb().prepare("DELETE FROM task_automations WHERE id = ?").run(id);
  return getDbChanges() > 0;
}

export function dbListTaskAutomationRuns(automationId: string, limit = 20): TaskAutomationRun[] {
  ensureTaskAutomationSchema();

  const rows = getDb()
    .prepare("SELECT * FROM task_automation_runs WHERE automation_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(automationId, limit) as TaskAutomationRunRow[];
  return rows.map(rowToTaskAutomationRun);
}

export function dbClaimTaskAutomationRun(input: {
  automationId: string;
  triggerTaskId: string;
  triggerEventId: number;
  triggerEventType: TaskAutomationEventType;
  message?: string;
}): TaskAutomationRun | null {
  ensureTaskAutomationSchema();

  const now = Date.now();
  getDb()
    .prepare(`
      INSERT OR IGNORE INTO task_automation_runs (
        automation_id, trigger_task_id, trigger_event_id, trigger_event_type, spawned_task_id, status, message, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      input.automationId,
      input.triggerTaskId,
      input.triggerEventId,
      input.triggerEventType,
      null,
      "claimed",
      input.message ?? null,
      now,
      now,
    );

  if (getDbChanges() === 0) {
    return null;
  }

  const row = getDb()
    .prepare(`
      SELECT *
      FROM task_automation_runs
      WHERE automation_id = ? AND trigger_event_id = ?
    `)
    .get(input.automationId, input.triggerEventId) as TaskAutomationRunRow | undefined;
  return row ? rowToTaskAutomationRun(row) : null;
}

export function dbFinalizeTaskAutomationRun(
  id: number,
  updates: {
    status: Exclude<TaskAutomationRunStatus, "claimed">;
    spawnedTaskId?: string;
    message?: string | null;
  },
): TaskAutomationRun {
  ensureTaskAutomationSchema();

  getDb()
    .prepare(`
      UPDATE task_automation_runs
      SET status = ?, spawned_task_id = ?, message = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(updates.status, updates.spawnedTaskId ?? null, updates.message ?? null, Date.now(), id);

  const row = getDb().prepare("SELECT * FROM task_automation_runs WHERE id = ?").get(id) as
    | TaskAutomationRunRow
    | undefined;
  if (!row) {
    throw new Error(`Task automation run not found: ${id}`);
  }
  return rowToTaskAutomationRun(row);
}

export function dbRecordTaskAutomationFire(automationId: string, firedAt = Date.now()): void {
  ensureTaskAutomationSchema();

  getDb()
    .prepare(`
      UPDATE task_automations
      SET fire_count = fire_count + 1,
          last_fired_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(firedAt, firedAt, automationId);
}
