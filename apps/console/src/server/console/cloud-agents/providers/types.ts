// The provider boundary of cloud agents. The core speaks only these types;
// `anthropic.ts` maps them to Claude Managed Agents and `fake.ts` keeps them
// in memory for tests. A second provider (OpenAI, self-hosted) is one more
// implementation of `CloudAgentProvider`.

import type { CloudEffort, CloudNetworking } from "../definition";

export type CloudProviderName = "anthropic";

/** Every provider failure, normalized. `auth` marks the organization's key invalid. */
export class CloudProviderError extends Error {
  constructor(
    /** `auth`: the key is rejected (401); `permission`: the key works but lacks access to a feature (403). */
    readonly kind: "auth" | "permission" | "not_found" | "rate_limited" | "invalid_request" | "unavailable" | "unknown",
    message: string,
    readonly status: number | null = null,
  ) {
    super(message);
    this.name = "CloudProviderError";
  }
}

export type ProviderMcpServer = {
  name: string;
  url: string;
  /** `ask`: every tool waits for a person, except `allowTools`. `allow`: every tool runs. */
  permission: "ask" | "allow";
  allowTools: string[];
};

export type ProviderAgentSpec = {
  name: string;
  description: string;
  system: string;
  model: string;
  effort: CloudEffort | null;
  webSearch: boolean;
  mcpServers: ProviderMcpServer[];
  skills: { skillId: string; version: string | null }[];
  metadata: Record<string, string>;
};

export type ProviderEnvironmentSpec = {
  name: string;
  networking: CloudNetworking;
  allowedHosts: string[];
  packages: { apt: string[]; pip: string[]; npm: string[] };
  metadata: Record<string, string>;
};

export type ProviderMcpCredential = {
  serverUrl: string;
  accessToken: string;
  accessTokenExpiresAt: Date;
  refreshToken: string;
  clientId: string;
  tokenEndpoint: string;
};

export type ProviderRepositoryResource = {
  /** `https://github.com/<owner>/<name>`. */
  url: string;
  authorizationToken: string;
  branch: string | null;
};

export type ProviderSessionStatus = "rescheduling" | "running" | "idle" | "terminated";

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** List price in US$ cents, as the provider reports it; null when not reported. */
  listCostCents: number | null;
  activeSeconds: number;
};

export type ProviderSession = {
  id: string;
  status: ProviderSessionStatus;
  usage: ProviderUsage;
};

export type ProviderStopReason =
  | { type: "end_turn" }
  | { type: "requires_action"; eventIds: string[] }
  | { type: "budget_reached" }
  | { type: "retries_exhausted" }
  | { type: "refusal" }
  | { type: "other"; raw: string };

export type ProviderEvent = { id: string; at: Date } & (
  | { kind: "message"; role: "agent" | "user"; text: string }
  | {
      kind: "tool_use";
      tool: string;
      /** The MCP server name for MCP tools, null for built-in tools. */
      server: string | null;
      input: unknown;
      /** How the provider evaluated the tool's permission policy; `ask` pauses for a person. */
      permission: "allow" | "ask" | "deny" | null;
    }
  | { kind: "tool_result"; toolUseId: string; isError: boolean; text: string }
  | { kind: "status"; status: ProviderSessionStatus; stopReason: ProviderStopReason | null }
  | { kind: "error"; errorType: string; message: string; retrying: boolean }
  | { kind: "other"; type: string }
);

export type ProviderEventPage = {
  events: ProviderEvent[];
  /** Opaque; pass it back to read the events after these. */
  cursor: string | null;
  hasMore: boolean;
};

export type ProviderOutput = { id: string; name: string; size: number; mimeType: string | null };

export type ProviderDownload = { body: ReadableStream<Uint8Array> | null; contentType: string; name: string; size: number | null };

export interface CloudAgentProvider {
  readonly name: CloudProviderName;
  /** A cheap authenticated call. Throws `CloudProviderError` (`auth` for a rejected key). */
  verifyKey(): Promise<void>;
  /** Uploads a skill, or a new version of `existingSkillId`. */
  ensureSkill(input: {
    displayTitle: string;
    directory: string;
    files: readonly { path: string; content: string }[];
    existingSkillId: string | null;
  }): Promise<{ skillId: string; version: string | null }>;
  /** Creates the agent, or updates it to a new version. */
  upsertAgent(spec: ProviderAgentSpec, existing: { agentId: string; version: number } | null): Promise<{ agentId: string; version: number }>;
  ensureEnvironment(spec: ProviderEnvironmentSpec, existingId: string | null): Promise<{ environmentId: string }>;
  createVault(input: { displayName: string; metadata: Record<string, string> }): Promise<{ vaultId: string }>;
  addMcpCredential(vaultId: string, credential: ProviderMcpCredential): Promise<{ credentialId: string }>;
  updateMcpCredential(vaultId: string, credentialId: string, credential: ProviderMcpCredential): Promise<void>;
  deleteVault(vaultId: string): Promise<void>;
  createSession(input: {
    agentId: string;
    agentVersion: number;
    environmentId: string;
    vaultIds: string[];
    budgetCents: number;
    resources: ProviderRepositoryResource[];
    title: string;
    metadata: Record<string, string>;
  }): Promise<{ sessionId: string }>;
  sendMessage(sessionId: string, text: string): Promise<void>;
  confirmTool(sessionId: string, toolUseId: string, decision: { allow: boolean; message?: string }): Promise<void>;
  interrupt(sessionId: string): Promise<void>;
  /** Null when the provider no longer has the session. */
  getSession(sessionId: string): Promise<ProviderSession | null>;
  listEvents(sessionId: string, cursor: string | null, limit: number): Promise<ProviderEventPage>;
  listOutputs(sessionId: string): Promise<ProviderOutput[]>;
  downloadOutput(sessionId: string, outputId: string): Promise<ProviderDownload>;
  deleteSession(sessionId: string): Promise<void>;
}

/** Per-request limits: interactive calls fit in a route's duration, the tick uses shorter ones. */
export type CloudProviderLimits = { timeoutMs: number; maxRetries: number };

export type CloudProviderFactory = (input: { provider: CloudProviderName; apiKey: string; limits?: CloudProviderLimits }) => CloudAgentProvider;
