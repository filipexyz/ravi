/**
 * Console cloud agents shapes (spec `cloud/agents`; Console HTTP API under
 * `/api/cli/cloud-agents`). Only the contract's fields: results are returned
 * as JSON by the CLI and the gateway.
 */

export const CLOUD_RUN_STATUSES = [
  "starting",
  "running",
  "waiting_approval",
  "completed",
  "failed",
  "stopped",
  "budget_exceeded",
] as const;

export type CloudRunStatus = (typeof CLOUD_RUN_STATUSES)[number];

/** Statuses a run never leaves. */
export const CLOUD_RUN_TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "stopped",
  "budget_exceeded",
]);

export function isTerminalCloudRunStatus(status: string): boolean {
  return CLOUD_RUN_TERMINAL_STATUSES.has(status);
}

export const CLOUD_RUN_EVENT_TYPES = ["message", "tool_call", "tool_result", "status", "approval", "error"] as const;

export type CloudRunEventType = (typeof CLOUD_RUN_EVENT_TYPES)[number];

export interface CloudUserRef {
  id: string;
  name: string | null;
}

export interface CloudCredential {
  provider: string;
  configured: boolean;
  /** Last characters of the key; the key itself never leaves the Console. */
  keyHint: string | null;
  status: string;
  verifiedAt: string | null;
  monthlyAlertUsd: number | null;
  monthCostUsd: number;
}

export interface CloudAgentConfig {
  budgetUsd: number;
  networking: string;
  webSearch: boolean;
  writes: string;
  raviMcp: boolean;
  mcpServers: string[];
  repositories: string[];
  schedule: { cron: string; timezone: string } | null;
}

export interface CloudAgent {
  id: string;
  projectId: string;
  name: string;
  library: { itemId: string; slug: string; scope: string; version: number | null };
  provider: string;
  model: string | null;
  status: string;
  deployedAt: string | null;
  deployedBy: CloudUserRef | null;
  lastError: string | null;
  config: CloudAgentConfig;
}

export interface CloudApproval {
  id: string;
  tool: string;
  server: string | null;
  inputPreview: string | null;
  status: string;
  requestedAt: string | null;
  decidedAt: string | null;
  decidedBy: CloudUserRef | null;
}

export interface CloudRunOutput {
  id: string;
  name: string;
  size: number;
}

/** Where a run came from: `kind: "task"` for `ravi tasks dispatch --cloud`. */
export interface CloudRunOrigin {
  kind: string;
  installationId: string | null;
  sessionName: string | null;
  taskId: string | null;
  /** When this installation acknowledged the result (`POST runs/<id>/delivered`). */
  deliveredAt: string | null;
}

export interface CloudRun {
  id: string;
  agentId: string;
  agentName: string;
  projectId: string;
  status: string;
  trigger: string;
  actor: CloudUserRef;
  prompt: string;
  result: string | null;
  budgetUsd: number | null;
  costUsd: number;
  runningSeconds: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  approvals: CloudApproval[];
  outputs: CloudRunOutput[];
  startedAt: string | null;
  endedAt: string | null;
  error: { code: string; message: string } | null;
  origin: CloudRunOrigin | null;
  url: string | null;
}

export interface CloudRunEvent {
  seq: number;
  at: string | null;
  type: string;
  role: string | null;
  text: string | null;
  tool: string | null;
  status: string | null;
}

export interface CloudSchedule {
  id: string;
  agentId: string;
  agentName: string;
  cron: string;
  timezone: string;
  prompt: string | null;
  budgetUsd: number | null;
  enabled: boolean;
  actor: CloudUserRef;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
}

export interface CloudRunStartBody {
  project: string;
  agent: string;
  prompt: string;
  budgetUsd?: number;
  repositories?: Array<{ repo: string; branch?: string }>;
  trigger?: "manual" | "task" | "agent";
  origin?: { kind: "task"; installationId: string; sessionName: string | null; taskId: string };
  idempotencyKey?: string;
}

export interface CloudScheduleBody {
  project?: string;
  agent?: string;
  cron?: string;
  timezone?: string;
  prompt?: string | null;
  budgetUsd?: number | null;
  enabled?: boolean;
}
