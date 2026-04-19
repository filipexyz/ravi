export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

export const SESSION_TRACE_EVENT_GROUPS = [
  "channel",
  "routing",
  "prompt",
  "dispatch",
  "runtime",
  "adapter",
  "tool",
  "approval",
  "response",
  "delivery",
  "session",
] as const;

export type KnownSessionTraceEventGroup = (typeof SESSION_TRACE_EVENT_GROUPS)[number];
export type SessionTraceEventGroup = KnownSessionTraceEventGroup | (string & {});

export const SESSION_TRACE_BLOB_KINDS = [
  "system_prompt",
  "user_prompt",
  "adapter_request",
  "tool_input",
  "tool_output",
  "provider_event",
] as const;

export type KnownSessionTraceBlobKind = (typeof SESSION_TRACE_BLOB_KINDS)[number];
export type SessionTraceBlobKind = KnownSessionTraceBlobKind | (string & {});

export interface RecordSessionEventInput {
  sessionKey: string;
  sessionName?: string | null;
  agentId?: string | null;
  runId?: string | null;
  turnId?: string | null;
  seq?: number;
  eventType: string;
  eventGroup: SessionTraceEventGroup;
  status?: string | null;
  timestamp?: number;
  sourceChannel?: string | null;
  sourceAccountId?: string | null;
  sourceChatId?: string | null;
  sourceThreadId?: string | null;
  messageId?: string | null;
  provider?: string | null;
  model?: string | null;
  payloadJson?: unknown;
  preview?: string | null;
  error?: string | null;
  durationMs?: number | null;
  createdAt?: number;
}

export interface SessionEventRecord {
  id: number;
  sessionKey: string;
  sessionName: string | null;
  agentId: string | null;
  runId: string | null;
  turnId: string | null;
  seq: number;
  eventType: string;
  eventGroup: string;
  status: string | null;
  timestamp: number;
  sourceChannel: string | null;
  sourceAccountId: string | null;
  sourceChatId: string | null;
  sourceThreadId: string | null;
  messageId: string | null;
  provider: string | null;
  model: string | null;
  payloadJson: JsonValue | null;
  preview: string | null;
  error: string | null;
  durationMs: number | null;
  createdAt: number;
}

interface SessionTraceBlobInputBase {
  kind: SessionTraceBlobKind;
  createdAt?: number;
}

export type RecordSessionBlobInput =
  | (SessionTraceBlobInputBase & {
      contentText: string;
      contentJson?: never;
    })
  | (SessionTraceBlobInputBase & {
      contentText?: never;
      contentJson: unknown;
    });

export interface SessionTraceBlobRecord {
  sha256: string;
  kind: string;
  sizeBytes: number;
  contentText: string | null;
  contentJson: JsonValue | null;
  redacted: boolean;
  createdAt: number;
}

export interface RedactionResult<T> {
  value: T;
  redacted: boolean;
}

export interface UpsertSessionTurnInput {
  turnId: string;
  sessionKey: string;
  sessionName?: string | null;
  runId?: string | null;
  agentId?: string | null;
  provider?: string | null;
  model?: string | null;
  effort?: string | null;
  thinking?: string | null;
  cwd?: string | null;
  status: string;
  resume?: boolean;
  fork?: boolean;
  providerSessionIdBefore?: string | null;
  providerSessionIdAfter?: string | null;
  userPromptSha256?: string | null;
  systemPromptSha256?: string | null;
  requestBlobSha256?: string | null;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  costUsd?: number;
  error?: string | null;
  abortReason?: string | null;
  startedAt?: number;
  completedAt?: number | null;
  updatedAt?: number;
}

export interface SessionTurnRecord {
  turnId: string;
  sessionKey: string;
  sessionName: string | null;
  runId: string | null;
  agentId: string | null;
  provider: string | null;
  model: string | null;
  effort: string | null;
  thinking: string | null;
  cwd: string | null;
  status: string;
  resume: boolean;
  fork: boolean;
  providerSessionIdBefore: string | null;
  providerSessionIdAfter: string | null;
  userPromptSha256: string | null;
  systemPromptSha256: string | null;
  requestBlobSha256: string | null;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  costUsd: number;
  error: string | null;
  abortReason: string | null;
  startedAt: number;
  completedAt: number | null;
  updatedAt: number;
}
