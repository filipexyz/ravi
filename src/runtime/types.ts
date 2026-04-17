export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type RuntimeBillingType = "api" | "subscription" | "unknown";

export type RuntimeProviderId = "claude" | "codex";
export type RuntimeToolAccessMode = "restricted" | "unrestricted";
export type RuntimeEffort = "low" | "medium" | "high" | "xhigh" | "max";
export type RuntimeThinking = "off" | "normal" | "verbose";

export type RuntimeStatus = "queued" | "thinking" | "compacting" | "idle";

export interface RuntimeCompatibilityRequest {
  requiresMcpServers?: boolean;
  requiresRemoteSpawn?: boolean;
  toolAccessMode?: RuntimeToolAccessMode;
}

export interface RuntimeCompatibilityIssue {
  code: "mcp_servers_unsupported" | "remote_spawn_unsupported" | "restricted_tool_access_unsupported";
  message: string;
}

export interface RuntimePromptMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  session_id: string;
  parent_tool_use_id: string | null;
}

export interface RuntimeToolUse {
  id: string;
  name: string;
  input?: unknown;
}

export interface RuntimeToolPermissionResult {
  behavior: "allow" | "deny";
  updatedInput?: Record<string, unknown>;
  reason?: string;
}

export type RuntimeToolPermissionHandler = (
  toolName: string,
  input: Record<string, unknown>,
) => Promise<RuntimeToolPermissionResult>;

export interface RuntimeHookMatcher {
  matcher?: string;
  hooks: Array<(...args: any[]) => any>;
}

export interface RuntimePlugin {
  type: "local";
  path: string;
}

export interface RuntimePrepareSessionRequest {
  agentId: string;
  cwd: string;
  plugins?: RuntimePlugin[];
}

export interface RuntimePrepareSessionResult {
  env?: Record<string, string>;
}

export interface RuntimeSessionState {
  params?: Record<string, unknown> | null;
  displayId?: string | null;
}

export interface RuntimeExecutionMetadata {
  provider?: string | null;
  model?: string | null;
  billingType?: RuntimeBillingType | null;
}

export interface RuntimeThreadMetadata {
  id?: string;
  title?: string;
}

export interface RuntimeTurnMetadata {
  id?: string;
  status?: string;
}

export interface RuntimeItemMetadata {
  id?: string;
  type?: string;
  status?: string;
  parentId?: string;
}

export interface RuntimeEventMetadata {
  provider?: RuntimeProviderId;
  source?: string;
  nativeEvent?: string;
  thread?: RuntimeThreadMetadata;
  turn?: RuntimeTurnMetadata;
  item?: RuntimeItemMetadata;
}

interface RuntimeEventBase {
  metadata?: RuntimeEventMetadata;
}

export interface RuntimeStartRequest {
  prompt: AsyncGenerator<RuntimePromptMessage>;
  model: string;
  effort?: RuntimeEffort;
  thinking?: RuntimeThinking;
  cwd: string;
  resume?: string;
  resumeSession?: RuntimeSessionState;
  forkSession?: boolean;
  abortController: AbortController;
  systemPromptAppend: string;
  env?: Record<string, string>;
  settingSources?: ("user" | "project")[];
  permissionOptions?: Record<string, unknown>;
  canUseTool?: RuntimeToolPermissionHandler;
  mcpServers?: Record<string, unknown>;
  hooks?: Record<string, RuntimeHookMatcher[]>;
  plugins?: RuntimePlugin[];
  remoteSpawn?: unknown;
}

export type RuntimeEvent =
  | ({
      type: "provider.raw";
      rawEvent: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "thread.started";
      thread: RuntimeThreadMetadata;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "turn.started";
      turn: RuntimeTurnMetadata;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "item.started";
      item: RuntimeItemMetadata;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "item.completed";
      item: RuntimeItemMetadata;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "text.delta";
      text: string;
    } & RuntimeEventBase)
  | ({
      type: "status";
      status: RuntimeStatus;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "assistant.message";
      text: string;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "tool.started";
      toolUse: RuntimeToolUse;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "tool.completed";
      toolUseId?: string;
      toolName?: string;
      content?: unknown;
      isError?: boolean;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "turn.interrupted";
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "turn.failed";
      error: string;
      recoverable?: boolean;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "turn.complete";
      providerSessionId?: string;
      session?: RuntimeSessionState;
      execution?: RuntimeExecutionMetadata;
      usage: RuntimeUsage;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase);

export interface RuntimeSessionHandle {
  provider: RuntimeProviderId;
  events: AsyncIterable<RuntimeEvent>;
  interrupt(): Promise<void>;
  setModel?(model: string): Promise<void>;
}

export interface RuntimeCapabilities {
  supportsSessionResume: boolean;
  supportsSessionFork: boolean;
  supportsPartialText: boolean;
  supportsToolHooks: boolean;
  supportsPlugins: boolean;
  supportsMcpServers: boolean;
  supportsRemoteSpawn: boolean;
}

export interface RuntimeProvider {
  id: RuntimeProviderId;
  getCapabilities(): RuntimeCapabilities;
  prepareSession?(
    input: RuntimePrepareSessionRequest,
  ): Promise<RuntimePrepareSessionResult> | RuntimePrepareSessionResult;
}

export interface SessionRuntimeProvider extends RuntimeProvider {
  startSession(input: RuntimeStartRequest): RuntimeSessionHandle;
}
