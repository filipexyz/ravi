/**
 * Console cloud agents shapes (spec `cloud/agents`; Console HTTP API under
 * `/api/cli/cloud-agents`). Only the contract's fields: results are returned
 * as JSON by the CLI and the gateway.
 */

export const CLOUD_RUN_STATUSES = [
  "starting",
  "running",
  "waiting_approval",
  "waiting_input",
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

export const CLOUD_RUN_EVENT_TYPES = [
  "message",
  "tool_call",
  "tool_result",
  "status",
  "approval",
  "question",
  "outcome",
  "workflow",
  "error",
] as const;

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
  /** Product additions (Console 0070); older Consoles omit them. */
  webFetch?: boolean;
  office?: string[];
  askHuman?: boolean;
  workflows?: boolean;
  secrets?: string[];
  memory?: "agent" | "person" | null;
  outcome?: { rubric: string; maxIterations: number } | null;
  placement?: "cloud" | "installation";
  provider?: "anthropic" | "ravi";
}

/** What a deployed agent can do; an owner or admin approves it (F3). */
export interface CloudManifestState {
  hash: string | null;
  approved: boolean;
  approvedAt: string | null;
  value: Record<string, unknown> | null;
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
  manifest?: CloudManifestState | null;
  /** Monthly cap in USD and the pause it caused, when set. */
  cap?: {
    monthlyCapUsd: number | null;
    monthSpentUsd: number;
    pausedAt: string | null;
    pausedReason: string | null;
  } | null;
  placementInstallationId?: string | null;
  catalogEntryId?: string | null;
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
  /** `pending` or `delivered` for a task run (the Console's delivery state). */
  delivery: string | null;
  /** When this installation acknowledged the result (`POST runs/<id>/delivered`). */
  deliveredAt: string | null;
}

/** Where a run's result, approvals and questions go (contract "Delivery target"). */
export interface CloudDelivery {
  kind: "session" | "page_room" | "none";
  installationId?: string;
  sessionName?: string;
  chat?: { channel: string; chatId: string; threadId?: string | null; instanceId?: string | null } | null;
  roomId?: string;
  siteId?: string;
}

/** A question the agent asked the run's person (`ask_human`). */
export interface CloudQuestion {
  id: string;
  question: string;
  options: string[];
  status: "pending" | "answered" | "expired";
  answer: string | null;
  askedAt: string | null;
  answeredAt: string | null;
  answeredBy: CloudUserRef | null;
}

export interface CloudRunFile {
  fileId: string;
  name: string;
  size: number;
}

export interface CloudRunOutcome {
  rubric: string;
  maxIterations: number;
  iterations: number;
  lastResult: string | null;
  feedback: string | null;
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
  /** Product additions (Console 0070); older Consoles omit them. */
  questions?: CloudQuestion[];
  delivery?: CloudDelivery | null;
  deliveredAt?: string | null;
  files?: CloudRunFile[];
  outcome?: CloudRunOutcome | null;
  threadKey?: string | null;
  triggerId?: string | null;
  billingMode?: "byok" | "credits";
  chargedBrl?: number | null;
  costBrl?: number | null;
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
  delivery?: CloudDelivery | null;
}

export interface CloudRunStartBody {
  project: string;
  agent: string;
  prompt: string;
  budgetUsd?: number;
  repositories?: Array<{ repo: string; branch?: string }>;
  trigger?: "manual" | "task" | "agent";
  /** The Console takes the installation from the `ravi login` session, never from the body. */
  origin?: { kind: "task"; sessionName: string; taskId: string };
  idempotencyKey?: string;
  /** `{ kind: "session", sessionName }`: the Console adds the installation from the login. */
  delivery?: { kind: "session" | "none"; sessionName?: string; chat?: CloudDelivery["chat"] };
  /** `slack:<instanceId>:<channelId>:<threadTs>` or `whatsapp:<instanceId>:<groupId>`. */
  threadKey?: string;
  files?: Array<{ name: string; contentBase64: string; mimeType?: string }>;
  outcome?: { rubric: string; maxIterations?: number };
  rows?: { viewId: string; limit?: number };
}

/** `POST schedules/<id>` (partial update; the Console refuses other keys). */
export interface CloudScheduleBody {
  cron?: string;
  timezone?: string;
  prompt?: string | null;
  budgetUsd?: number | null;
  enabled?: boolean;
  delivery?: CloudRunStartBody["delivery"] | null;
}

// ---------------------------------------------------------------------------
// Product shapes (F1-F4). Transport only: the Console decides what they hold.

export interface CloudSecret {
  id: string;
  projectId: string | null;
  name: string;
  /** Last characters only; the value never leaves the Console. */
  valueHint: string | null;
  allowedHosts: string[];
  createdAt: string | null;
  lastUsedAt: string | null;
}

export interface CloudTrigger {
  id: string;
  projectId: string;
  agentId: string;
  agentName: string;
  actor: CloudUserRef;
  source: "bases" | "mail" | "meetings" | "pages_comments";
  filter: { baseId?: string; viewId?: string; events?: string[]; mailboxId?: string; siteId?: string };
  prompt: string;
  delivery: CloudDelivery | null;
  enabled: boolean;
  dailyCap: number;
  batchWindowSeconds: number;
  dedupeWindowSeconds: number;
  budgetUsd: number | null;
  firedToday: number;
  lastFiredAt: string | null;
  pausedReason: string | null;
}

export interface CloudOrgSettings {
  billingMode: "byok" | "credits";
  monthlyCapUsd: number | null;
  pausedAt: string | null;
  pausedReason: string | null;
  dailyEventRunsCap: number;
}

export interface CloudCreditEntry {
  id: string;
  kind: string;
  amountBrl: number;
  status: string;
  runId: string | null;
  fxRate: number | null;
  paymentUrl: string | null;
  pixCopyPaste: string | null;
  createdAt: string | null;
}

export interface CloudCredits {
  mode: "byok" | "credits";
  balanceBrl: number;
  fxRate: number | null;
  monthSpentBrl: number;
  entries: CloudCreditEntry[];
}

export interface CloudCatalogEntry {
  id: string;
  name: string;
  sector: string | null;
  summary: string | null;
  publisher: { id: string; name: string | null };
  manifest: Record<string, unknown> | null;
  status: string;
}

export interface CloudCatalogPack {
  id: string;
  name: string;
  sector: string | null;
  summary: string | null;
  entryIds: string[];
  publisher: { id: string; name: string | null };
}

export interface CloudWorker {
  id: string;
  agentId: string;
  agentName: string;
  installationId: string;
  providerEnvironmentId: string | null;
  status: "waiting_key" | "online" | "offline" | "disabled";
  lastSeenAt: string | null;
}
