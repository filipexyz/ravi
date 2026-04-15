import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getRaviStateDir } from "../utils/paths.js";
import { resolveTaskProfileForTask, taskProfileRequiresTaskDocument, taskProfileUsesTaskDocument } from "./profiles.js";
import type { ResolvedTaskProfile, TaskPriority, TaskRecord, TaskStatus } from "./types.js";

export const TASK_DOC_FILENAME = "TASK.md";

export interface TaskDocSection {
  title: string;
  timestamp?: number;
  lines: string[];
}

export interface TaskDocFrontmatterState {
  id?: string;
  title?: string;
  parentTaskId?: string;
  status?: TaskStatus;
  priority?: TaskPriority;
  progress?: number;
  progressNote?: string;
  summary?: string;
  blockerReason?: string;
  archivedAt?: number;
  archiveReason?: string;
}

const TASK_DOC_STATUS_VALUES = new Set<TaskStatus>(["open", "dispatched", "in_progress", "blocked", "done", "failed"]);
const TASK_DOC_PRIORITY_VALUES = new Set<TaskPriority>(["low", "normal", "high", "urgent"]);

function formatTaskDocTimestamp(timestamp?: number): string {
  return new Date(timestamp ?? Date.now()).toISOString();
}

function yamlScalar(value: number | string | null | undefined): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "number") return String(value);
  return JSON.stringify(value);
}

function parseFrontmatterScalar(raw: string): string | number | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === "null") return null;
  if (trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed) as string | number | null;
    } catch {
      return trimmed;
    }
  }
  if (/^-?\d+$/.test(trimmed)) {
    return Number.parseInt(trimmed, 10);
  }
  return trimmed;
}

function buildTaskFrontmatter(task: TaskRecord, preservedFrontmatter?: TaskDocFrontmatterState): string {
  const lines = [
    "---",
    `id: ${yamlScalar(task.id)}`,
    `title: ${yamlScalar(task.title)}`,
    `parent_task_id: ${yamlScalar(task.parentTaskId)}`,
    `status: ${yamlScalar(task.status)}`,
    `priority: ${yamlScalar(task.priority)}`,
    `progress: ${yamlScalar(task.progress)}`,
    `progress_note: ${yamlScalar(preservedFrontmatter?.progressNote)}`,
    `summary: ${yamlScalar(task.summary)}`,
    `blocker_reason: ${yamlScalar(task.blockerReason)}`,
    `archived_at: ${yamlScalar(task.archivedAt)}`,
    `archive_reason: ${yamlScalar(task.archiveReason)}`,
    "---",
  ];
  return `${lines.join("\n")}\n`;
}

function buildInitialTaskBody(task: TaskRecord): string {
  return [
    `# ${task.title}`,
    "",
    "## Objective",
    task.instructions,
    "",
    "## Workflow",
    "- Edit this file first.",
    "- Keep structured runtime fields in the frontmatter above.",
    "- Use `ravi tasks ...` only after editing the TASK.md so the runtime can recognize the changes.",
    "",
    "## Plan",
    "",
    "## Notes",
    "",
    "## Activity Log",
    "",
    "## Outcome",
    "",
    "## Blockers",
  ].join("\n");
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n?/, "");
}

function extractFrontmatter(content: string): string {
  const match = content.match(/^---\n([\s\S]*?)\n---\n?/);
  return match?.[1] ?? "";
}

function appendSection(body: string, section: TaskDocSection): string {
  const lines = [
    `### ${section.title} · ${formatTaskDocTimestamp(section.timestamp)}`,
    "",
    ...section.lines.map((line) => `- ${line}`),
  ];
  const normalizedBody = body.trimEnd();
  return `${normalizedBody}\n\n${lines.join("\n")}\n`;
}

export function getCanonicalTaskDir(taskId: string): string {
  return join(getRaviStateDir(), "tasks", taskId);
}

export function getTaskDocPath(task: Pick<TaskRecord, "id" | "taskDir">): string {
  return join(task.taskDir ?? getCanonicalTaskDir(task.id), TASK_DOC_FILENAME);
}

export function taskDocExists(task: Pick<TaskRecord, "id" | "taskDir">): boolean {
  return existsSync(getTaskDocPath(task));
}

export function readTaskDocFrontmatter(task: Pick<TaskRecord, "id" | "taskDir">): TaskDocFrontmatterState {
  const docPath = getTaskDocPath(task);
  if (!existsSync(docPath)) {
    return {};
  }

  const frontmatter = extractFrontmatter(readFileSync(docPath, "utf8"));
  if (!frontmatter) {
    return {};
  }

  const state: TaskDocFrontmatterState = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([a-z0-9_]+):\s*(.*)$/i);
    if (!match) continue;
    const [, key, rawValue] = match;
    const parsed = parseFrontmatterScalar(rawValue);

    switch (key) {
      case "id":
        if (typeof parsed === "string" && parsed) state.id = parsed;
        break;
      case "title":
        if (typeof parsed === "string" && parsed) state.title = parsed;
        break;
      case "parent_task_id":
        if (typeof parsed === "string" && parsed) state.parentTaskId = parsed;
        break;
      case "status":
        if (typeof parsed === "string" && TASK_DOC_STATUS_VALUES.has(parsed as TaskStatus)) {
          state.status = parsed as TaskStatus;
        }
        break;
      case "priority":
        if (typeof parsed === "string" && TASK_DOC_PRIORITY_VALUES.has(parsed as TaskPriority)) {
          state.priority = parsed as TaskPriority;
        }
        break;
      case "progress":
        if (typeof parsed === "number" && Number.isFinite(parsed)) {
          state.progress = Math.max(0, Math.min(100, Math.round(parsed)));
        }
        break;
      case "progress_note":
        state.progressNote = typeof parsed === "string" && parsed ? parsed : undefined;
        break;
      case "summary":
        state.summary = typeof parsed === "string" && parsed ? parsed : undefined;
        break;
      case "blocker_reason":
        state.blockerReason = typeof parsed === "string" && parsed ? parsed : undefined;
        break;
      case "archived_at":
        if (typeof parsed === "number" && Number.isFinite(parsed)) {
          state.archivedAt = parsed;
        }
        break;
      case "archive_reason":
        state.archiveReason = typeof parsed === "string" && parsed ? parsed : undefined;
        break;
    }
  }

  return state;
}

export function writeTaskDoc(
  task: TaskRecord,
  options: {
    initializeSection?: TaskDocSection;
    appendSection?: TaskDocSection;
  } = {},
): string {
  const profile = resolveTaskProfileForTask(task);
  if (!taskProfileUsesTaskDocument(profile)) {
    throw new Error(`Task ${task.id} profile ${profile.id} forbids TASK.md materialization.`);
  }
  const taskDir = task.taskDir ?? getCanonicalTaskDir(task.id);
  const docTask: TaskRecord = task.taskDir ? task : { ...task, taskDir };
  const docPath = getTaskDocPath(docTask);

  mkdirSync(taskDir, { recursive: true });

  const fileExists = existsSync(docPath);
  let body = fileExists ? stripFrontmatter(readFileSync(docPath, "utf8")) : buildInitialTaskBody(docTask);
  const preservedFrontmatter = fileExists ? readTaskDocFrontmatter(docTask) : undefined;

  if (!fileExists && options.initializeSection) {
    body = appendSection(body, options.initializeSection);
  }
  if (options.appendSection) {
    body = appendSection(body, options.appendSection);
  }

  writeFileSync(docPath, `${buildTaskFrontmatter(docTask, preservedFrontmatter)}${body.trimEnd()}\n`, "utf8");
  return docPath;
}

function withCanonicalTaskDir(task: TaskRecord): TaskRecord {
  return task.taskDir ? task : { ...task, taskDir: getCanonicalTaskDir(task.id) };
}

export function ensureRequiredTaskDocument(
  task: TaskRecord,
  options: {
    profile?: ResolvedTaskProfile;
    initializeSection?: TaskDocSection;
  } = {},
): TaskRecord {
  const profile = options.profile ?? resolveTaskProfileForTask(task);
  if (!taskProfileRequiresTaskDocument(profile)) {
    return task;
  }

  const documentedTask = withCanonicalTaskDir(task);
  if (!taskDocExists(documentedTask)) {
    writeTaskDoc(documentedTask, {
      ...(options.initializeSection ? { initializeSection: options.initializeSection } : {}),
    });
  }

  return documentedTask;
}

export function appendTaskDocumentSection(
  task: TaskRecord,
  section: TaskDocSection,
  options: {
    profile?: ResolvedTaskProfile;
    initializeSection?: TaskDocSection;
  } = {},
): TaskRecord {
  const profile = options.profile ?? resolveTaskProfileForTask(task);
  if (!taskProfileUsesTaskDocument(profile)) {
    return task;
  }

  if (!taskProfileRequiresTaskDocument(profile) && !taskDocExists(task)) {
    return task;
  }

  const documentedTask = taskDocExists(task)
    ? task
    : ensureRequiredTaskDocument(task, {
        profile,
        ...(options.initializeSection ? { initializeSection: options.initializeSection } : {}),
      });
  writeTaskDoc(documentedTask, { appendSection: section });
  return documentedTask;
}
