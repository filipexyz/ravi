// Words for cloud agents states, money and time, shared by the screens and
// tested on their own.

import type { Tone } from "@/ui/badge";
import type {
  CloudAgent,
  CloudApprovalStatus,
  CloudCredential,
  CloudRun,
  CloudRunEvent,
  CloudRunStatus,
  CloudRunTrigger,
} from "@/server/console/cloud-agents/types";

/** How often an active run's detail and events refresh. */
export const ACTIVE_RUN_REFRESH_MS = 3_000;
/** How often a list with an active run in it refreshes. */
export const ACTIVE_LIST_REFRESH_MS = 8_000;

const RUN_STATUS: Record<CloudRunStatus, { label: string; tone: Tone; hint: string }> = {
  starting: { label: "Starting", tone: "info", hint: "Ravi is creating the session at Anthropic." },
  running: { label: "Running", tone: "info", hint: "The agent is working." },
  waiting_approval: { label: "Needs approval", tone: "warn", hint: "The agent asked to make a change and waits for a person." },
  completed: { label: "Completed", tone: "ok", hint: "The agent finished its turn. You can send a follow-up." },
  failed: { label: "Failed", tone: "err", hint: "The run stopped on an error." },
  stopped: { label: "Stopped", tone: "neutral", hint: "Someone stopped the run." },
  budget_exceeded: { label: "Budget reached", tone: "warn", hint: "The run spent its budget and was stopped." },
};

export function runStatus(status: CloudRunStatus) {
  return RUN_STATUS[status] ?? { label: status, tone: "neutral" as Tone, hint: "" };
}

export function isActiveRun(run: Pick<CloudRun, "status">) {
  return run.status === "starting" || run.status === "running" || run.status === "waiting_approval";
}

/** A follow-up reaches the agent while it runs, waits, or after it finished its turn. */
export function canFollowUp(run: Pick<CloudRun, "status">) {
  return run.status === "running" || run.status === "waiting_approval" || run.status === "completed";
}

const TRIGGERS: Record<CloudRunTrigger, string> = {
  manual: "Started by hand",
  schedule: "Schedule",
  task: "Task",
  page: "Page",
  agent: "Agent",
};

export function triggerLabel(trigger: CloudRunTrigger) {
  return TRIGGERS[trigger] ?? trigger;
}

export function agentStatus(agent: Pick<CloudAgent, "status" | "lastError">): { label: string; tone: Tone } {
  if (agent.status === "failed") return { label: "Deploy failed", tone: "err" };
  if (agent.status === "archived") return { label: "Archived", tone: "neutral" };
  return { label: "Ready", tone: "ok" };
}

export function approvalStatus(status: CloudApprovalStatus): { label: string; tone: Tone } {
  switch (status) {
    case "pending":
      return { label: "Waiting for you", tone: "warn" };
    case "approved":
      return { label: "Approved", tone: "ok" };
    case "denied":
      return { label: "Denied", tone: "err" };
    case "expired":
      return { label: "Expired", tone: "neutral" };
    default:
      return { label: status, tone: "neutral" };
  }
}

export function credentialState(credential: CloudCredential): { label: string; tone: Tone } {
  if (credential.status === "active") return { label: "Active", tone: "ok" };
  if (credential.status === "invalid") return { label: "Rejected by Anthropic", tone: "err" };
  return { label: "Not set", tone: "neutral" };
}

/** US$ with cents; small amounts keep enough digits to be told apart. */
export function formatUsd(value: number) {
  if (!Number.isFinite(value)) return "US$ 0.00";
  const digits = value > 0 && value < 0.01 ? 4 : 2;
  return `US$ ${value.toFixed(digits)}`;
}

export function formatSeconds(totalSeconds: number) {
  const seconds = Math.max(0, Math.round(totalSeconds));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

/** Wall time from start to end (or now, while it runs). */
export function runDuration(run: Pick<CloudRun, "startedAt" | "endedAt">, now = Date.now()) {
  const start = Date.parse(run.startedAt);
  const end = run.endedAt ? Date.parse(run.endedAt) : now;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return formatSeconds((end - start) / 1000);
}

export function formatTokens(value: number) {
  if (value < 1000) return String(value);
  if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** One line for a run event, for the timeline; `null` when the event has nothing to show. */
export function eventLine(event: CloudRunEvent): { title: string; body: string | null; tone: Tone } | null {
  switch (event.type) {
    case "message":
      return { title: event.role === "user" ? "You" : "Agent", body: event.text ?? null, tone: "neutral" };
    case "tool_call":
      return { title: `Used ${event.tool ?? "a tool"}`, body: event.text ?? null, tone: "neutral" };
    case "tool_result":
      return {
        title: event.status === "error" ? `${event.tool ?? "The tool"} failed` : `${event.tool ?? "The tool"} answered`,
        body: event.text ?? null,
        tone: event.status === "error" ? "warn" : "neutral",
      };
    case "approval": {
      const status = event.status ? approvalWord(event.status) : "asked for approval";
      return { title: `${event.tool ?? "A change"} ${status}`, body: event.text ?? null, tone: event.status === "denied" ? "err" : "warn" };
    }
    case "error":
      return { title: "Error", body: event.text ?? null, tone: "err" };
    case "status":
      if (!event.status && !event.text) return null;
      return { title: event.status ? statusWord(event.status) : "Status", body: event.text ?? null, tone: "info" };
    default:
      return null;
  }
}

function approvalWord(status: string) {
  if (status === "approved") return "was approved";
  if (status === "denied") return "was denied";
  if (status === "expired") return "expired";
  return "asked for approval";
}

/** The provider's session states as the run's events carry them (`<status>[:<stop reason>]`). */
const SESSION_STATUS: Record<string, string> = {
  running: "Working",
  rescheduling: "Retrying",
  terminated: "Session ended",
  idle: "Paused",
  "idle:end_turn": "Finished its turn",
  "idle:requires_action": "Waiting for approval",
  "idle:budget_reached": "Reached its budget",
  "idle:retries_exhausted": "Gave up after retries",
  "idle:refusal": "Declined the request",
};

function statusWord(status: string) {
  if (SESSION_STATUS[status]) return SESSION_STATUS[status]!;
  if (status in RUN_STATUS) return RUN_STATUS[status as CloudRunStatus].label;
  const text = status.replace(/[_-]+/g, " ").trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "Status";
}

/** The browser's IANA timezone, for new schedules. */
export function browserTimezone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

const CRON_PRESETS: Record<string, string> = {
  "0 9 * * 1-5": "Weekdays at 09:00",
  "0 9 * * *": "Every day at 09:00",
  "0 * * * *": "Every hour",
  "0 9 * * 1": "Mondays at 09:00",
};

export const SCHEDULE_PRESETS = Object.entries(CRON_PRESETS).map(([cron, label]) => ({ cron, label }));

/** A sentence for the common crons; the expression itself otherwise. */
export function describeCron(cron: string) {
  return CRON_PRESETS[cron.trim().split(/\s+/).join(" ")] ?? cron;
}

/** A budget typed by a person, in US$, or an error to show. Empty means the agent's default. */
export function parseBudgetInput(raw: string): { value: number | null; error: string | null } {
  const text = raw.trim().replace(",", ".");
  if (!text) return { value: null, error: null };
  const value = Number(text);
  if (!Number.isFinite(value) || value < 0.5 || value > 200) return { value: null, error: "A budget from US$ 0.50 to US$ 200." };
  return { value: Math.round(value * 100) / 100, error: null };
}
