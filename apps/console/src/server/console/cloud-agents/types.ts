// The JSON shapes of the cloud agents API (CLI routes and Console UI), as the
// contract names them. camelCase, dates as ISO strings.

export type CloudRunStatus =
  | "starting"
  | "running"
  | "waiting_approval"
  | "completed"
  | "failed"
  | "stopped"
  | "budget_exceeded";
export type CloudRunTrigger = "manual" | "schedule" | "task" | "page" | "agent";
export type CloudApprovalStatus = "pending" | "approved" | "denied" | "expired";

export const CLOUD_ACTIVE_RUN_STATUSES: readonly CloudRunStatus[] = ["starting", "running", "waiting_approval"];
export const CLOUD_TERMINAL_RUN_STATUSES: readonly CloudRunStatus[] = ["completed", "failed", "stopped", "budget_exceeded"];

export type CloudPerson = { id: string; name: string };

export type CloudCredential = {
  provider: "anthropic";
  configured: boolean;
  keyHint: string | null;
  /** `missing` when no key was ever set or the last one was removed. */
  status: "active" | "invalid" | "missing";
  verifiedAt: string | null;
  monthlyAlertUsd: number | null;
  monthCostUsd: number;
};

export type CloudAgent = {
  id: string;
  projectId: string;
  name: string;
  library: { itemId: string; slug: string; scope: string; version: number | null };
  provider: "anthropic";
  model: string | null;
  status: "ready" | "failed" | "archived";
  deployedAt: string | null;
  deployedBy: CloudPerson | null;
  lastError: string | null;
  config: {
    budgetUsd: number;
    networking: "limited" | "unrestricted";
    webSearch: boolean;
    writes: "ask" | "auto";
    raviMcp: boolean;
    mcpServers: string[];
    repositories: string[];
    schedule: { cron: string; timezone: string } | null;
  };
};

export type CloudApproval = {
  id: string;
  tool: string;
  server: string | null;
  inputPreview: string | null;
  status: CloudApprovalStatus;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: CloudPerson | null;
};

export type CloudRunOutput = { id: string; name: string; size: number };

export type CloudRun = {
  id: string;
  agentId: string;
  agentName: string;
  projectId: string;
  status: CloudRunStatus;
  trigger: CloudRunTrigger;
  actor: CloudPerson;
  prompt: string;
  result: string | null;
  budgetUsd: number;
  costUsd: number;
  runningSeconds: number;
  tokens: { input: number; output: number; cacheRead: number; cacheWrite: number };
  approvals: CloudApproval[];
  outputs: CloudRunOutput[];
  startedAt: string;
  endedAt: string | null;
  error: { code: string; message: string } | null;
  origin: Record<string, unknown> | null;
  url: string;
};

export type CloudRunEvent = {
  seq: number;
  at: string;
  type: "message" | "tool_call" | "tool_result" | "status" | "approval" | "error";
  role?: "agent" | "user";
  text?: string;
  tool?: string;
  status?: string;
};

export type CloudSchedule = {
  id: string;
  agentId: string;
  agentName: string;
  cron: string;
  timezone: string;
  prompt: string | null;
  budgetUsd: number | null;
  enabled: boolean;
  actor: CloudPerson;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastRunId: string | null;
};
