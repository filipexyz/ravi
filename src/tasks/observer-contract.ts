import { z } from "zod";
import type { AgentConfig } from "../router/index.js";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import { listRuntimeModels } from "../runtime/model-catalog.js";
import { validateRuntimeModelSelector } from "../runtime/model-validation.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "../runtime/provider-registry.js";
import { resolveRuntimeDefaults } from "../runtime/runtime-defaults.js";
import type { RuntimeProviderId } from "../runtime/types.js";
import { resolveTaskProfileForTask, taskProfileUsesObserver } from "./profiles.js";
import type { TaskRecord } from "./types.js";

/**
 * Task-side contract for the observer sidecar. The observer is a normal
 * observer: it reads the worker session and calls the regular task tools. This
 * module only resolves its policy/model and renders the checklist kept for
 * `ravi tasks show`. It never parses prose.
 */
export const TASK_OBSERVER_ROLE = "task-observer";
export const TASK_OBSERVER_ACTOR = "task-observer";
/** A long turn is read every five minutes instead of only when it ends. */
export const TASK_OBSERVER_PULSE_MS = 5 * 60 * 1000;
export const TASK_OBSERVER_MAX_CHECKLIST_ITEMS = 30;
export const TASK_OBSERVER_CHECKLIST_ITEM_MAX = 200;

export interface TaskObserverChecklistItem {
  item: string;
  done: boolean;
}

const TaskObserverChecklistItemSchema = z.object({
  item: z.string().trim().min(1).max(TASK_OBSERVER_CHECKLIST_ITEM_MAX),
  done: z.boolean(),
});

const TaskObserverChecklistSchema = z.array(TaskObserverChecklistItemSchema).max(TASK_OBSERVER_MAX_CHECKLIST_ITEMS);

export function emptyTaskObserverState(taskId: string, now = Date.now()): TaskObserverState {
  return { taskId, checklist: [], updatedAt: now };
}

function trimChecklistItem(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length <= TASK_OBSERVER_CHECKLIST_ITEM_MAX) return trimmed;
  const suffix = "… [truncated]";
  return `${trimmed.slice(0, Math.max(0, TASK_OBSERVER_CHECKLIST_ITEM_MAX - suffix.length))}${suffix}`;
}

function coerceChecklistDone(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    return ["true", "yes", "y", "done", "1"].includes(value.trim().toLowerCase());
  }
  return false;
}

/**
 * Normalize an operator/observer checklist payload. Invalid entries are
 * dropped, items are bounded, and the list is capped instead of failing so a
 * slightly noisy tool call still records progress.
 */
export function normalizeTaskObserverChecklist(value: unknown): TaskObserverChecklistItem[] {
  if (!Array.isArray(value)) return [];
  const items: TaskObserverChecklistItem[] = [];
  for (const entry of value) {
    if (items.length >= TASK_OBSERVER_MAX_CHECKLIST_ITEMS) break;
    const record =
      entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    const rawItem = record?.item ?? (typeof entry === "string" ? entry : undefined);
    if (typeof rawItem !== "string") continue;
    const item = trimChecklistItem(rawItem);
    if (!item) continue;
    items.push({ item, done: coerceChecklistDone(record?.done) });
  }
  return items;
}

export interface TaskObserverState {
  taskId: string;
  checklist: TaskObserverChecklistItem[];
  updatedAt: number;
}

interface TaskObserverStateRow {
  task_id: string;
  checklist_json: string | null;
  updated_at: number;
}

let schemaDbPath: string | null = null;

function ensureTaskObserverSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaDbPath === dbPath) return;
  // Kept column-compatible with the verdict-era table; unused columns stay NULL.
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS task_observer_state (
      task_id TEXT PRIMARY KEY,
      checklist_json TEXT,
      last_status TEXT,
      last_message TEXT,
      last_verdict_at INTEGER,
      last_delivery_id TEXT,
      nudges_since_progress INTEGER NOT NULL DEFAULT 0,
      verdict_count INTEGER NOT NULL DEFAULT 0,
      stalled_at INTEGER,
      updated_at INTEGER NOT NULL
    );
  `);
  schemaDbPath = dbPath;
}

function parseChecklist(raw: string | null): TaskObserverChecklistItem[] {
  if (!raw) return [];
  try {
    const parsed = TaskObserverChecklistSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}

export function dbGetTaskObserverState(taskId: string): TaskObserverState | null {
  ensureTaskObserverSchema();
  const row = getDb().prepare("SELECT * FROM task_observer_state WHERE task_id = ?").get(taskId) as
    | TaskObserverStateRow
    | undefined;
  if (!row) return null;
  return {
    taskId: row.task_id,
    checklist: parseChecklist(row.checklist_json),
    updatedAt: row.updated_at,
  };
}

export function dbSaveTaskObserverState(state: TaskObserverState): TaskObserverState {
  ensureTaskObserverSchema();
  getDb()
    .prepare(
      `
        INSERT INTO task_observer_state (
          task_id, checklist_json, nudges_since_progress, verdict_count, updated_at
        ) VALUES (?, ?, 0, 0, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          checklist_json = excluded.checklist_json,
          updated_at = excluded.updated_at
      `,
    )
    .run(state.taskId, state.checklist.length > 0 ? JSON.stringify(state.checklist) : null, state.updatedAt);
  return dbGetTaskObserverState(state.taskId)!;
}

/** Persist the observer's checklist. The only writer is the tool path, never a prose parser. */
export function dbSaveTaskObserverChecklist(
  taskId: string,
  checklist: TaskObserverChecklistItem[],
  now = Date.now(),
): TaskObserverState {
  const current = dbGetTaskObserverState(taskId) ?? emptyTaskObserverState(taskId, now);
  return dbSaveTaskObserverState({ ...current, checklist, updatedAt: now });
}

/** The cheaper model of the agent's provider, when the catalog has one; otherwise the agent's own model. */
export function resolveTaskObserverLightweightModel(provider: RuntimeProviderId): string | undefined {
  if (provider === "claude") return "haiku";
  if (provider === "codex") {
    const ids = listRuntimeModels("codex").map((model) => model.id);
    return ids.find((id) => /mini/i.test(id)) ?? ids.find((id) => /spark/i.test(id));
  }
  return undefined;
}

function resolveAgentProvider(agent?: Pick<AgentConfig, "provider"> | null): RuntimeProviderId {
  if (agent?.provider) return agent.provider;
  try {
    return resolveRuntimeDefaults().provider.value;
  } catch {
    return DEFAULT_RUNTIME_PROVIDER_ID;
  }
}

/** Whether a task gets the observer sidecar, and with which model. */
export function resolveTaskObserverPolicy(
  task: Pick<TaskRecord, "profileId" | "profileSnapshot">,
  agent?: Pick<AgentConfig, "provider"> | null,
): { enabled: false } | { enabled: true; model?: string } {
  const profile = resolveTaskProfileForTask(task);
  if (!taskProfileUsesObserver(profile)) return { enabled: false };
  const provider = resolveAgentProvider(agent);
  const model = profile.observer?.model ?? resolveTaskObserverLightweightModel(provider);
  if (!model) return { enabled: true };
  return validateRuntimeModelSelector(provider, model).ok ? { enabled: true, model } : { enabled: true };
}

export interface TaskObserverSummary {
  enabled: boolean;
  model: string | null;
  checklist: TaskObserverChecklistItem[];
  updatedAt: number | null;
}

/** What `ravi tasks show` reports about the task observer; null for profiles without one. */
export function buildTaskObserverSummary(
  task: TaskRecord,
  agent?: Pick<AgentConfig, "provider"> | null,
): TaskObserverSummary | null {
  const policy = resolveTaskObserverPolicy(task, agent);
  if (!policy.enabled) return null;
  const state = dbGetTaskObserverState(task.id);
  return {
    enabled: true,
    model: policy.model ?? null,
    checklist: state?.checklist ?? [],
    updatedAt: state?.updatedAt ?? null,
  };
}
