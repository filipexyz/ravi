import { z } from "zod";
import type { AgentConfig } from "../router/index.js";
import { getDb, getRaviDbPath } from "../router/router-db.js";
import { listRuntimeModels } from "../runtime/model-catalog.js";
import { validateRuntimeModelSelector } from "../runtime/model-validation.js";
import type { ObserverRule } from "../runtime/observation-plane.js";
import { DEFAULT_RUNTIME_PROVIDER_ID } from "../runtime/provider-registry.js";
import { resolveRuntimeDefaults } from "../runtime/runtime-defaults.js";
import type { RuntimeProviderId } from "../runtime/types.js";
import { resolveTaskProfileForTask, taskProfileUsesObserver } from "./profiles.js";
import type { TaskRecord } from "./types.js";

/**
 * The built-in task observer: one sidecar session per observed task that reads
 * the worker's conversation and returns a structured verdict. The runtime, not
 * the observer, applies the verdict to the task.
 */
export const TASK_OBSERVER_ROLE = "task-observer";
export const TASK_OBSERVER_PROFILE_ID = "task-observer";
export const TASK_OBSERVER_RULE_ID = "builtin:task-observer";
export const TASK_OBSERVER_ACTOR = "task-observer";
/** A long turn is read every five minutes instead of only when it ends. */
export const TASK_OBSERVER_PULSE_MS = 5 * 60 * 1000;
/** The observer gets no tools: every grant it holds is this one, which matches nothing. */
export const TASK_OBSERVER_NO_TOOLS_GRANT = "none";
export const TASK_OBSERVER_MAX_CHECKLIST_ITEMS = 30;
/** One nudge per stretch without progress; the next stop is reported to the requester. */
export const TASK_OBSERVER_MAX_NUDGES = 1;

const TASK_OBSERVER_EVENT_TYPES = [
  "message.user",
  "message.assistant",
  "tool.start",
  "tool.end",
  "turn.complete",
  "turn.failed",
  "turn.interrupt",
];

export const TASK_OBSERVER_VERDICT_STATUSES = [
  "unchanged",
  "progress",
  "blocked",
  "done",
  "failed",
  "stopped",
] as const;
export type TaskObserverVerdictStatus = (typeof TASK_OBSERVER_VERDICT_STATUSES)[number];

const TaskObserverChecklistItemSchema = z.object({
  item: z.string().trim().min(1).max(200),
  done: z.boolean(),
});

export const TaskObserverVerdictSchema = z.object({
  status: z.enum(TASK_OBSERVER_VERDICT_STATUSES),
  progress: z.number().min(0).max(100).optional(),
  message: z.string().trim().max(2000).optional(),
  checklist: z.array(TaskObserverChecklistItemSchema).max(TASK_OBSERVER_MAX_CHECKLIST_ITEMS).optional(),
  missing: z.string().trim().max(1000).optional(),
  evidence: z.string().trim().max(500).optional(),
});

export type TaskObserverVerdict = z.infer<typeof TaskObserverVerdictSchema>;
export type TaskObserverChecklistItem = z.infer<typeof TaskObserverChecklistItemSchema>;

const VERDICT_BLOCK = /<task-verdict>([\s\S]*?)<\/task-verdict>/gi;

/** Parse the last `<task-verdict>{...}</task-verdict>` block of an observer reply. */
export function parseTaskObserverVerdict(
  text: string,
): { ok: true; verdict: TaskObserverVerdict } | { ok: false; reason: "missing" | "invalid"; error?: string } {
  const blocks = [...text.matchAll(VERDICT_BLOCK)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) return { ok: false, reason: "missing" };
  const json = last
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    return { ok: false, reason: "invalid", error: error instanceof Error ? error.message : String(error) };
  }
  const parsed = TaskObserverVerdictSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, reason: "invalid", error: parsed.error.issues[0]?.message ?? "invalid verdict" };
  }
  return { ok: true, verdict: parsed.data };
}

export interface TaskObserverState {
  taskId: string;
  checklist: TaskObserverChecklistItem[];
  lastStatus?: TaskObserverVerdictStatus;
  lastMessage?: string;
  lastVerdictAt?: number;
  lastDeliveryId?: string;
  nudgesSinceProgress: number;
  verdictCount: number;
  stalledAt?: number;
  updatedAt: number;
}

interface TaskObserverStateRow {
  task_id: string;
  checklist_json: string | null;
  last_status: TaskObserverVerdictStatus | null;
  last_message: string | null;
  last_verdict_at: number | null;
  last_delivery_id: string | null;
  nudges_since_progress: number;
  verdict_count: number;
  stalled_at: number | null;
  updated_at: number;
}

let schemaDbPath: string | null = null;

function ensureTaskObserverSchema(): void {
  const dbPath = getRaviDbPath();
  if (schemaDbPath === dbPath) return;
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
    CREATE TABLE IF NOT EXISTS task_observer_deliveries (
      delivery_id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_task_observer_deliveries_task ON task_observer_deliveries(task_id);
  `);
  schemaDbPath = dbPath;
}

function parseChecklist(raw: string | null): TaskObserverChecklistItem[] {
  if (!raw) return [];
  try {
    const parsed = z.array(TaskObserverChecklistItemSchema).safeParse(JSON.parse(raw));
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
    ...(row.last_status ? { lastStatus: row.last_status } : {}),
    ...(row.last_message ? { lastMessage: row.last_message } : {}),
    ...(row.last_verdict_at !== null ? { lastVerdictAt: row.last_verdict_at } : {}),
    ...(row.last_delivery_id ? { lastDeliveryId: row.last_delivery_id } : {}),
    nudgesSinceProgress: row.nudges_since_progress,
    verdictCount: row.verdict_count,
    ...(row.stalled_at !== null ? { stalledAt: row.stalled_at } : {}),
    updatedAt: row.updated_at,
  };
}

export function dbSaveTaskObserverState(state: TaskObserverState): TaskObserverState {
  ensureTaskObserverSchema();
  getDb()
    .prepare(
      `
        INSERT INTO task_observer_state (
          task_id, checklist_json, last_status, last_message, last_verdict_at, last_delivery_id,
          nudges_since_progress, verdict_count, stalled_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(task_id) DO UPDATE SET
          checklist_json = excluded.checklist_json,
          last_status = excluded.last_status,
          last_message = excluded.last_message,
          last_verdict_at = excluded.last_verdict_at,
          last_delivery_id = excluded.last_delivery_id,
          nudges_since_progress = excluded.nudges_since_progress,
          verdict_count = excluded.verdict_count,
          stalled_at = excluded.stalled_at,
          updated_at = excluded.updated_at
      `,
    )
    .run(
      state.taskId,
      state.checklist.length > 0 ? JSON.stringify(state.checklist) : null,
      state.lastStatus ?? null,
      state.lastMessage ?? null,
      state.lastVerdictAt ?? null,
      state.lastDeliveryId ?? null,
      state.nudgesSinceProgress,
      state.verdictCount,
      state.stalledAt ?? null,
      state.updatedAt,
    );
  return dbGetTaskObserverState(state.taskId)!;
}

/** Claim a delivery once: a redelivered observer turn must not apply its verdict twice. */
export function dbClaimTaskObserverDelivery(deliveryId: string, taskId: string, now = Date.now()): boolean {
  ensureTaskObserverSchema();
  return (
    getDb()
      .prepare("INSERT OR IGNORE INTO task_observer_deliveries (delivery_id, task_id, applied_at) VALUES (?, ?, ?)")
      .run(deliveryId, taskId, now).changes > 0
  );
}

export function emptyTaskObserverState(taskId: string, now = Date.now()): TaskObserverState {
  return { taskId, checklist: [], nudgesSinceProgress: 0, verdictCount: 0, updatedAt: now };
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

/** Whether a task gets the built-in observer, and with which model. */
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

/** A synthetic rule: never stored, rebuilt on every launch of an observed task's session. */
export function buildTaskObserverRule(input: { agentId: string; model?: string }): ObserverRule {
  return {
    id: TASK_OBSERVER_RULE_ID,
    enabled: true,
    scope: "task",
    priority: 0,
    observerRole: TASK_OBSERVER_ROLE,
    observerAgentId: input.agentId,
    ...(input.model ? { observerModel: input.model } : {}),
    observerProfileId: TASK_OBSERVER_PROFILE_ID,
    observerMode: "report",
    eventTypes: [...TASK_OBSERVER_EVENT_TYPES],
    deliveryPolicy: "end_of_turn",
    tagInherited: false,
    permissionGrants: [TASK_OBSERVER_NO_TOOLS_GRANT],
    metadata: {
      builtin: TASK_OBSERVER_ROLE,
      observationDetail: true,
      pulseMs: TASK_OBSERVER_PULSE_MS,
    },
    createdAt: 0,
    updatedAt: 0,
  };
}

export function isTaskObserverRuleId(ruleId: string | undefined): boolean {
  return ruleId === TASK_OBSERVER_RULE_ID;
}

function truncateText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 15)}... [truncated]` : value;
}

export function formatTaskObserverChecklist(checklist: TaskObserverChecklistItem[]): string {
  if (checklist.length === 0) return "";
  return checklist.map((entry) => `- [${entry.done ? "x" : " "}] ${entry.item}`).join("\n");
}

/** The `input` root of the task-observer profile templates. Every leaf is a string. */
export function buildTaskObserverPromptInput(
  task: TaskRecord,
  trigger: string,
  state: TaskObserverState | null = dbGetTaskObserverState(task.id),
): Record<string, unknown> {
  const checklist = formatTaskObserverChecklist(state?.checklist ?? []);
  return {
    trigger,
    task: {
      id: task.id,
      title: task.title,
      status: task.status,
      progress: String(task.progress),
      instructions: truncateText(task.instructions.trim() || "-", 6000),
      brief: task.taskDir ? `${task.taskDir}/TASK.md` : "-",
      checklist: checklist || "(none yet: build it from the instructions in this verdict)",
      lastStatus: state?.lastStatus ?? "-",
      lastMessage: state?.lastMessage ?? "-",
      nudges: String(state?.nudgesSinceProgress ?? 0),
    },
  };
}

export interface TaskObserverSummary {
  enabled: boolean;
  model: string | null;
  checklist: TaskObserverChecklistItem[];
  lastStatus: TaskObserverVerdictStatus | null;
  lastMessage: string | null;
  lastVerdictAt: number | null;
  nudgesSinceProgress: number;
  verdictCount: number;
  stalledAt: number | null;
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
    lastStatus: state?.lastStatus ?? null,
    lastMessage: state?.lastMessage ?? null,
    lastVerdictAt: state?.lastVerdictAt ?? null,
    nudgesSinceProgress: state?.nudgesSinceProgress ?? 0,
    verdictCount: state?.verdictCount ?? 0,
    stalledAt: state?.stalledAt ?? null,
  };
}
