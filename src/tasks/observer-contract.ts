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

export const TASK_OBSERVER_CHECKLIST_ITEM_MAX = 200;
export const TASK_OBSERVER_MESSAGE_MAX = 2000;
export const TASK_OBSERVER_MISSING_MAX = 1000;
export const TASK_OBSERVER_EVIDENCE_MAX = 500;

/** The strict wire shape; the parser below normalizes before validating against it. */
const TaskObserverChecklistItemSchema = z.object({
  item: z.string().trim().min(1).max(TASK_OBSERVER_CHECKLIST_ITEM_MAX),
  done: z.boolean(),
});

export const TaskObserverVerdictSchema = z.object({
  status: z.enum(TASK_OBSERVER_VERDICT_STATUSES),
  progress: z.number().min(0).max(100).optional(),
  message: z.string().trim().max(TASK_OBSERVER_MESSAGE_MAX).optional(),
  checklist: z.array(TaskObserverChecklistItemSchema).max(TASK_OBSERVER_MAX_CHECKLIST_ITEMS).optional(),
  missing: z.string().trim().max(TASK_OBSERVER_MISSING_MAX).optional(),
  evidence: z.string().trim().max(TASK_OBSERVER_EVIDENCE_MAX).optional(),
});

export type TaskObserverVerdict = z.infer<typeof TaskObserverVerdictSchema>;
export type TaskObserverChecklistItem = z.infer<typeof TaskObserverChecklistItemSchema>;

/** A non-fatal repair the runtime made to an otherwise usable verdict. */
export interface TaskObserverVerdictWarning {
  /** Dotted path of the field, e.g. `checklist[3].item`. */
  path: string;
  code: "truncated" | "dropped" | "coerced" | "ignored" | "repaired" | "unexpected";
  message: string;
}

export interface TaskObserverVerdictRejection {
  /** Dotted path of the fatal field, or `json` when the payload did not parse. */
  path: string;
  /** Bounded, sanitized rendering of the offending value. */
  value?: string;
  message: string;
}

export type TaskObserverVerdictParseResult =
  | { ok: true; verdict: TaskObserverVerdict; warnings?: TaskObserverVerdictWarning[] }
  | { ok: false; reason: "missing" | "invalid"; error?: string; rejection?: TaskObserverVerdictRejection };

const VERDICT_BLOCK = /<\s*task-verdict\s*>([\s\S]*?)<\s*\/\s*task-verdict\s*>/gi;
const VERDICT_OPEN = /<\s*task-verdict\s*>/gi;
const VERDICT_CLOSE = /<\s*\/\s*task-verdict\s*>/gi;

/** Keys the contract knows about; anything else is ignored with a bounded warning. */
const VERDICT_KEYS = new Set(["status", "progress", "message", "checklist", "missing", "evidence"]);

/** Bound a value for a log line or task event without leaking an unbounded payload. */
export function boundTaskObserverValue(value: unknown, max = 160): string {
  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function withEllipsis(value: string, max: number): { value: string; truncated: boolean } {
  if (value.length <= max) return { value, truncated: false };
  const suffix = "… [truncated]";
  return { value: `${value.slice(0, Math.max(0, max - suffix.length))}${suffix}`, truncated: true };
}

function lastMatchEnd(pattern: RegExp, text: string): number | undefined {
  let end: number | undefined;
  for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
    if (match.index !== undefined) end = match.index + match[0].length;
  }
  return end;
}

function lastOpenStart(text: string): number | undefined {
  let start: number | undefined;
  for (const match of text.matchAll(new RegExp(VERDICT_OPEN.source, "gi"))) {
    if (match.index !== undefined) start = match.index;
  }
  return start;
}

/**
 * The body of the last verdict block. A closing tag is optional: a stream cut in
 * the middle of the verdict still leaves a repairable payload.
 */
function extractVerdictBody(text: string): string | undefined {
  const complete = [...text.matchAll(VERDICT_BLOCK)];
  const completeBody = complete.at(-1)?.[1];
  const completeEnd = lastMatchEnd(VERDICT_CLOSE, text);
  const openStart = lastOpenStart(text);
  const openEnd =
    openStart === undefined
      ? undefined
      : openStart + (text.slice(openStart).match(/^<\s*task-verdict\s*>/i)?.[0].length ?? 0);
  if (openEnd !== undefined && (completeEnd === undefined || openEnd > completeEnd)) {
    return text.slice(openEnd);
  }
  return completeBody;
}

function stripFence(raw: string): string {
  return raw
    .trim()
    .replace(/^```[\w-]*\s*/, "")
    .replace(/\s*```\s*$/, "")
    .trim();
}

function tryParseJson(candidate: string): unknown {
  try {
    return JSON.parse(candidate);
  } catch {
    return undefined;
  }
}

/**
 * Close a payload cut in the middle of a string/array/object. This is the only
 * repair the parser attempts: it never invents content, it only closes what the
 * stream left open. Returns null when the shape cannot be closed coherently.
 */
function closeTruncatedJson(text: string): string | null {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of text) {
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char);
    else if (char === "}" || char === "]") stack.pop();
  }
  let out = text;
  if (inString) out += escaped ? '\\"' : '"';
  // A value cut mid-literal (`tr`, `12.`) cannot be completed safely; drop the
  // last incomplete member and let the caller retry the repair once.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let candidate = out;
    const closers = [...stack].reverse().map((open) => (open === "{" ? "}" : "]"));
    candidate += closers.join("");
    if (tryParseJson(candidate) !== undefined) return candidate;
    const trimmed = out.replace(/[,\s]*$/, "");
    const boundary = Math.max(
      trimmed.lastIndexOf(","),
      trimmed.lastIndexOf(":"),
      trimmed.lastIndexOf("{"),
      trimmed.lastIndexOf("["),
    );
    if (boundary <= 0) return null;
    out = trimmed.slice(0, boundary);
    // Recompute closers for the shortened payload by falling through the loop.
    stack.length = 0;
    inString = false;
    escaped = false;
    for (const char of out) {
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === "{" || char === "[") stack.push(char);
      else if (char === "}" || char === "]") stack.pop();
    }
  }
  return null;
}

function extractJsonPayload(body: string): { raw: unknown; repaired: boolean } | { error: string } {
  const cleaned = stripFence(body);
  const direct = tryParseJson(cleaned);
  if (direct !== undefined) return { raw: direct, repaired: false };
  const first = cleaned.indexOf("{");
  const last = cleaned.lastIndexOf("}");
  if (first >= 0 && last > first) {
    const inner = tryParseJson(cleaned.slice(first, last + 1));
    if (inner !== undefined) return { raw: inner, repaired: false };
  }
  const start = first >= 0 ? first : 0;
  const repaired = closeTruncatedJson(cleaned.slice(start));
  if (repaired) {
    const parsed = tryParseJson(repaired);
    if (parsed !== undefined) return { raw: parsed, repaired: true };
  }
  return { error: "verdict payload is not valid JSON" };
}

function coerceBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (value === 1 || value === 0) return value === 1;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["true", "yes", "y", "done", "1"].includes(normalized)) return true;
    if (["false", "no", "n", "open", "0"].includes(normalized)) return false;
  }
  return undefined;
}

function coerceProgress(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value.replace(/%$/, "").trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function normalizeTextField(
  raw: Record<string, unknown>,
  key: "message" | "missing" | "evidence",
  max: number,
  warnings: TaskObserverVerdictWarning[],
): string | undefined {
  if (raw[key] === undefined || raw[key] === null) return undefined;
  const value = raw[key];
  if (typeof value !== "string") {
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    warnings.push({ path: key, code: "dropped", message: `${key} is not a string; ignored` });
    return undefined;
  }
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const bounded = withEllipsis(trimmed, max);
  if (bounded.truncated) {
    warnings.push({ path: key, code: "truncated", message: `${key} exceeded ${max} characters and was truncated` });
  }
  return bounded.value;
}

function normalizeChecklist(
  value: unknown,
  warnings: TaskObserverVerdictWarning[],
): TaskObserverChecklistItem[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    warnings.push({ path: "checklist", code: "dropped", message: "checklist is not an array; ignored" });
    return undefined;
  }
  const items: TaskObserverChecklistItem[] = [];
  for (const [index, entry] of value.entries()) {
    if (items.length >= TASK_OBSERVER_MAX_CHECKLIST_ITEMS) {
      warnings.push({
        path: "checklist",
        code: "dropped",
        message: `checklist exceeded ${TASK_OBSERVER_MAX_CHECKLIST_ITEMS} items; extras were dropped`,
      });
      break;
    }
    const record =
      entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>) : undefined;
    const rawItem = record?.item ?? (typeof entry === "string" ? entry : undefined);
    if (typeof rawItem !== "string" || !rawItem.trim()) {
      warnings.push({ path: `checklist[${index}].item`, code: "dropped", message: "empty or missing item; dropped" });
      continue;
    }
    const bounded = withEllipsis(rawItem.trim(), TASK_OBSERVER_CHECKLIST_ITEM_MAX);
    if (bounded.truncated) {
      warnings.push({
        path: `checklist[${index}].item`,
        code: "truncated",
        message: `checklist item exceeded ${TASK_OBSERVER_CHECKLIST_ITEM_MAX} characters and was truncated`,
      });
    }
    const done = coerceBoolean(record?.done);
    if (done === undefined) {
      warnings.push({
        path: `checklist[${index}].done`,
        code: "coerced",
        message: "done was not a boolean; treated as false",
      });
    }
    items.push({ item: bounded.value, done: done ?? false });
  }
  return items.length > 0 ? items : undefined;
}

function normalizeVerdict(
  raw: unknown,
  repaired: boolean,
):
  | { ok: true; verdict: TaskObserverVerdict; warnings: TaskObserverVerdictWarning[] }
  | { ok: false; rejection: TaskObserverVerdictRejection } {
  const warnings: TaskObserverVerdictWarning[] = [];
  if (repaired) {
    warnings.push({
      path: "json",
      code: "repaired",
      message: "verdict payload was truncated and closed by the runtime",
    });
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      ok: false,
      rejection: { path: "json", value: boundTaskObserverValue(raw), message: "verdict payload is not an object" },
    };
  }
  const record = raw as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!VERDICT_KEYS.has(key)) {
      warnings.push({ path: key, code: "unexpected", message: `unexpected field ${key} was ignored` });
    }
  }
  const statusRaw = record.status;
  const status =
    typeof statusRaw === "string"
      ? TASK_OBSERVER_VERDICT_STATUSES.find((candidate) => candidate === statusRaw.trim().toLowerCase())
      : undefined;
  if (!status) {
    return {
      ok: false,
      rejection: {
        path: "status",
        value: boundTaskObserverValue(statusRaw),
        message: statusRaw === undefined ? "status is missing" : "status is not a known value",
      },
    };
  }

  const verdict: TaskObserverVerdict = { status };
  if (record.progress !== undefined && record.progress !== null) {
    const progress = coerceProgress(record.progress);
    if (progress === undefined) {
      warnings.push({ path: "progress", code: "dropped", message: "progress is not a number; ignored" });
    } else {
      verdict.progress = Math.max(0, Math.min(100, Math.round(progress)));
      if (verdict.progress !== Math.round(progress)) {
        warnings.push({ path: "progress", code: "coerced", message: "progress was clamped to 0..100" });
      }
    }
  }
  const message = normalizeTextField(record, "message", TASK_OBSERVER_MESSAGE_MAX, warnings);
  const missing = normalizeTextField(record, "missing", TASK_OBSERVER_MISSING_MAX, warnings);
  const evidence = normalizeTextField(record, "evidence", TASK_OBSERVER_EVIDENCE_MAX, warnings);
  if (message !== undefined) verdict.message = message;
  if (missing !== undefined) verdict.missing = missing;
  if (evidence !== undefined) verdict.evidence = evidence;
  const checklist = normalizeChecklist(record.checklist, warnings);
  if (checklist !== undefined) verdict.checklist = checklist;
  return { ok: true, verdict, warnings };
}

function parseVerdictBody(body: string): TaskObserverVerdictParseResult {
  const payload = extractJsonPayload(body);
  if ("error" in payload) {
    return {
      ok: false,
      reason: "invalid",
      error: payload.error,
      rejection: { path: "json", value: boundTaskObserverValue(stripFence(body)), message: payload.error },
    };
  }
  const normalized = normalizeVerdict(payload.raw, payload.repaired);
  if (!normalized.ok) {
    return { ok: false, reason: "invalid", error: normalized.rejection.message, rejection: normalized.rejection };
  }
  return normalized.warnings.length > 0
    ? { ok: true, verdict: normalized.verdict, warnings: normalized.warnings }
    : { ok: true, verdict: normalized.verdict };
}

function candidateTexts(text: string, fragments?: string[]): string[] {
  const cleaned = text.replace(/^\uFEFF/, "");
  const candidates = [cleaned];
  if (fragments && fragments.length > 1) {
    const chunks = fragments.map((fragment) => fragment.replace(/^\uFEFF/, ""));
    // A verdict split across streaming fragments must be tried without the
    // separator the accumulator inserts for prose: a JSON string cut mid-token
    // breaks when `\n\n` is spliced into it.
    candidates.push(chunks.join(""), chunks.join("\n"));
  }
  return [...new Set(candidates)];
}

/**
 * Parse the last `<task-verdict>{...}</task-verdict>` block of an observer reply.
 *
 * The contract is deliberately tolerant: only a missing or unknown `status` is
 * fatal. Length limits are the runtime's job (truncate with an ellipsis), an
 * invalid checklist item is dropped, and malformed optional fields are ignored
 * with a warning. A long checklist item may never discard the whole verdict.
 */
export function parseTaskObserverVerdict(
  text: string,
  options: { fragments?: string[] } = {},
): TaskObserverVerdictParseResult {
  let firstInvalid: TaskObserverVerdictParseResult | undefined;
  for (const candidate of candidateTexts(text, options.fragments)) {
    const body = extractVerdictBody(candidate);
    if (body === undefined) continue;
    const parsed = parseVerdictBody(body);
    if (parsed.ok) return parsed;
    firstInvalid ??= parsed;
  }
  return firstInvalid ?? { ok: false, reason: "missing" };
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
