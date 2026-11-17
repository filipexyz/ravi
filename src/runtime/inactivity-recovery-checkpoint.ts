import { isApprovalGatedTool } from "./tool-liveness.js";

/**
 * Bounded task checkpoint for an inactivity recovery that cannot replay the
 * original turn. After tools have run, the fresh provider thread would
 * otherwise see only the generic inactivity notice.
 */

const OBJECTIVE_CHARS = 400;
const PROGRESS_LINE_CHARS = 140;
const ARTIFACT_CHARS = 80;
const MAX_PROGRESS_LINES = 4;
const MAX_ARTIFACTS = 6;
const MAX_CHECKPOINT_CHARS = 1_600;
const ARTIFACT_PATH_SOURCE = String.raw`(?:^|[^\w./~-])((?:~\/|\.{1,2}\/|\/)?(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8})\b`;

export interface InactivityRecoveryCheckpointEvent {
  eventType: string;
  status?: string | null;
  preview?: string | null;
  payloadJson?: unknown;
}

export interface InactivityRecoveryCheckpointInput {
  objective?: string | null;
  taskId?: string | null;
  events?: readonly InactivityRecoveryCheckpointEvent[];
  maxChars?: number;
}

/**
 * Visible assistant text is the only signal that clears the consecutive
 * inactivity-recovery budget. Empty text, `@@SILENT@@`, and `HEARTBEAT_OK`
 * are not task progress.
 */
export function inactivityRecoveryCompletionHasProgress(responseText: string): boolean {
  const visible = responseText
    .replace(/@@SILENT@@/g, "")
    .replace(/\bHEARTBEAT_OK\b/g, "")
    .trim();
  return visible.length > 0;
}

export function buildInactivityRecoveryCheckpoint(input: InactivityRecoveryCheckpointInput): string | null {
  const events = input.events ?? [];
  const objective = clip(collapseWhitespace(input.objective ?? ""), OBJECTIVE_CHARS);
  const taskId = input.taskId?.trim() || "";
  const progress = collectProgress(events);
  const openTools = collectOpenTools(events);
  const artifacts = collectArtifacts(events);
  if (!objective && !taskId && progress.length === 0 && openTools.length === 0 && artifacts.length === 0) {
    return null;
  }

  const lines = [
    "[Checkpoint]",
    "The previous turn already ran tools, so its original prompt is not replayed. Continue from this checkpoint.",
    "",
    "Objective:",
    objective || "(original task text unavailable)",
  ];
  if (taskId) lines.push(`Task: ${taskId}`);
  lines.push("", "Verified progress:");
  if (progress.length === 0) lines.push("- (no completed tool or assistant result recorded)");
  else for (const line of progress) lines.push(`- ${line}`);
  lines.push("", "Remaining work:", "- Continue the objective from the last verified step.");
  for (const tool of openTools) {
    lines.push(
      isApprovalGatedTool(tool)
        ? `- \`${tool}\` was waiting for a human answer that never came. Do not call it again on your own: tell the user it is still waiting and stop.`
        : `- Finish or redo incomplete tool \`${tool}\`.`,
    );
  }
  lines.push("", "Artifact hints:");
  if (artifacts.length === 0) lines.push("- (none recorded)");
  else for (const artifact of artifacts) lines.push(`- ${artifact}`);

  return clip(lines.join("\n"), input.maxChars ?? MAX_CHECKPOINT_CHARS);
}

function collectProgress(events: readonly InactivityRecoveryCheckpointEvent[]): string[] {
  const lines: string[] = [];
  for (const event of events) {
    if (lines.length >= MAX_PROGRESS_LINES) break;
    if (event.eventType === "tool.end") {
      const payload = asRecord(event.payloadJson);
      const toolName = stringField(payload, "toolName") ?? (event.preview?.trim() || "tool");
      const failed = payload?.isError === true || event.status === "failed";
      const output = clip(collapseWhitespace(stringifyValue(payload?.output)), PROGRESS_LINE_CHARS);
      lines.push(`${toolName} ${failed ? "failed" : "completed"}${output ? `: ${output}` : ""}`);
      continue;
    }
    if (event.eventType === "assistant.message") {
      const preview = clip(collapseWhitespace((event.preview ?? "").replace(/@@SILENT@@/g, "")), PROGRESS_LINE_CHARS);
      if (!preview || preview === "HEARTBEAT_OK") continue;
      lines.push(`assistant: ${preview}`);
    }
  }
  return lines;
}

function collectOpenTools(events: readonly InactivityRecoveryCheckpointEvent[]): string[] {
  const started = new Map<string, string>();
  for (const event of events) {
    const payload = asRecord(event.payloadJson);
    const toolId = stringField(payload, "toolId") ?? event.preview?.trim() ?? "";
    if (!toolId) continue;
    if (event.eventType === "tool.start") {
      started.set(toolId, stringField(payload, "toolName") ?? (event.preview?.trim() || toolId));
    } else if (event.eventType === "tool.end") {
      started.delete(toolId);
    }
  }
  return [...started.values()].slice(0, MAX_PROGRESS_LINES);
}

function collectArtifacts(events: readonly InactivityRecoveryCheckpointEvent[]): string[] {
  const found = new Set<string>();
  for (const event of events) {
    if (found.size >= MAX_ARTIFACTS) break;
    const strings: string[] = [];
    collectStrings(event.payloadJson, strings);
    if (event.preview) strings.push(event.preview);
    for (const value of strings) {
      for (const path of artifactPaths(value)) {
        found.add(clip(path, ARTIFACT_CHARS));
        if (found.size >= MAX_ARTIFACTS) break;
      }
      if (found.size >= MAX_ARTIFACTS) break;
    }
  }
  return [...found];
}

function artifactPaths(value: string): string[] {
  const paths: string[] = [];
  for (const match of value.matchAll(new RegExp(ARTIFACT_PATH_SOURCE, "g"))) {
    const path = match[1]?.trim();
    if (path) paths.push(path);
  }
  return paths;
}

function collectStrings(value: unknown, out: string[], depth = 0): void {
  if (out.length >= 40 || depth > 4) return;
  if (typeof value === "string") {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectStrings(item, out, depth + 1);
    return;
  }
  if (value && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      collectStrings(nested, out, depth + 1);
    }
  }
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function clip(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const trimmed = value.slice(0, Math.max(0, maxChars - 15)).trimEnd();
  return `${trimmed}... [truncated]`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  const value = record?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
