import type { RuntimeEffort } from "./effort.js";

export type { RuntimeEffort } from "./effort.js";

export interface RuntimeUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
}

export type RuntimeBillingType = "api" | "subscription" | "unknown";

export type RuntimeProviderId = string;
export type RuntimeToolAccessMode = "restricted" | "unrestricted";
export type RuntimeThinking = "off" | "normal" | "verbose";
export type RuntimeToolAccessRequirement = "tool_and_executable" | "tool_surface";
export type RuntimeExecutionMode = "sdk" | "subprocess-rpc" | "subprocess-cli" | "embedded" | "external-service";
export type RuntimeDynamicToolMode = "none" | "host";
export type RuntimeSessionStateMode = "none" | "provider-session-id" | "thread-id" | "file-backed" | "external-store";
export type RuntimeUsageSemantics = "terminal-event" | "streaming" | "unavailable";
export type RuntimeToolPermissionMode = "ravi-host" | "provider-native" | "unrestricted";
export type RuntimeSystemPromptMode = "append" | "override" | "provider-composed";
export type RuntimeTerminalEventGuarantee = "provider" | "adapter";

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

export type RuntimeApprovalKind = "command_execution" | "file_change" | "permission" | "user_input";

export interface RuntimeApprovalQuestionOption {
  label: string;
  description?: string;
}

export interface RuntimeApprovalQuestion {
  id?: string;
  header?: string;
  question: string;
  options?: RuntimeApprovalQuestionOption[];
  multiSelect?: boolean;
}

export interface RuntimeApprovalRequest {
  kind: RuntimeApprovalKind;
  method?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  rawRequest?: Record<string, unknown>;
  metadata?: RuntimeEventMetadata;
}

export interface RuntimeApprovalResult {
  approved: boolean;
  reason?: string;
  updatedInput?: Record<string, unknown>;
  answers?: Record<string, string>;
  permissions?: unknown;
  inherited?: boolean;
}

export interface RuntimeApprovalEvent {
  kind: RuntimeApprovalKind;
  method?: string;
  toolName?: string;
  approved?: boolean;
  reason?: string;
  inherited?: boolean;
}

export type RuntimeApprovalHandler = (request: RuntimeApprovalRequest) => Promise<RuntimeApprovalResult>;

export interface RuntimeCapabilityAuthorizationRequest {
  permission: string;
  objectType: string;
  objectId: string;
  eventData?: Record<string, unknown>;
}

export interface RuntimeCapabilityAuthorizationResult {
  allowed: boolean;
  inherited: boolean;
  reason?: string;
}

export interface RuntimeCommandAuthorizationRequest {
  command: string;
  input?: Record<string, unknown>;
  eventData?: Record<string, unknown>;
}

export interface RuntimeToolUseAuthorizationRequest {
  toolName: string;
  input?: Record<string, unknown>;
  eventData?: Record<string, unknown>;
}

export interface RuntimeUserInputRequest {
  questions: RuntimeApprovalQuestion[];
  eventData?: Record<string, unknown>;
}

export interface RuntimeDynamicToolSpec {
  name: string;
  description: string;
  inputSchema: unknown;
  deferLoading?: boolean;
}

export type RuntimeDynamicToolCallContentItem =
  | {
      type: "inputText";
      text: string;
    }
  | {
      type: "inputImage";
      imageUrl: string;
    };

export interface RuntimeDynamicToolCallRequest {
  toolName: string;
  callId?: string;
  arguments?: unknown;
  rawRequest?: Record<string, unknown>;
  metadata?: RuntimeEventMetadata;
}

export interface RuntimeDynamicToolCallResult {
  success: boolean;
  contentItems: RuntimeDynamicToolCallContentItem[];
  reason?: string;
}

export type RuntimeDynamicToolCallHandler = (
  request: RuntimeDynamicToolCallRequest,
) => Promise<RuntimeDynamicToolCallResult>;

export interface RuntimeDynamicToolExecutionOptions {
  eventData?: Record<string, unknown>;
}

export interface RuntimeHostServices {
  authorizeCapability(request: RuntimeCapabilityAuthorizationRequest): Promise<RuntimeCapabilityAuthorizationResult>;
  authorizeCommandExecution(request: RuntimeCommandAuthorizationRequest): Promise<RuntimeApprovalResult>;
  authorizeToolUse(request: RuntimeToolUseAuthorizationRequest): Promise<RuntimeApprovalResult>;
  requestUserInput(request: RuntimeUserInputRequest): Promise<RuntimeApprovalResult>;
  listDynamicTools(): RuntimeDynamicToolSpec[];
  executeDynamicTool(
    request: RuntimeDynamicToolCallRequest,
    options?: RuntimeDynamicToolExecutionOptions,
  ): Promise<RuntimeDynamicToolCallResult>;
}

export type RuntimeControlOperation =
  | "thread.list"
  | "thread.read"
  | "thread.rollback"
  | "thread.fork"
  | "session.new"
  | "session.read"
  | "session.switch"
  | "session.fork"
  | "session.clone"
  | "session.compact"
  | "turn.steer"
  | "turn.follow_up"
  | "turn.interrupt"
  | "model.set"
  | "thinking.set";

export interface RuntimeControlState {
  provider: RuntimeProviderId;
  threadId?: string;
  turnId?: string;
  activeTurn?: boolean;
  supportedOperations?: RuntimeControlOperation[];
}

export interface RuntimeControlRequest {
  operation: RuntimeControlOperation;
  threadId?: string;
  turnId?: string;
  expectedTurnId?: string;
  text?: string;
  input?: unknown[];
  includeTurns?: boolean;
  cursor?: string | null;
  limit?: number | null;
  sortKey?: string | null;
  modelProviders?: string[] | null;
  sourceKinds?: string[] | null;
  archived?: boolean | null;
  cwd?: string | null;
  searchTerm?: string | null;
  numTurns?: number;
  path?: string | null;
  params?: Record<string, unknown>;
}

export interface RuntimeControlResult {
  ok: boolean;
  operation: RuntimeControlOperation;
  data?: Record<string, unknown>;
  state?: RuntimeControlState;
  error?: string;
}

export interface RuntimeControlCapabilities {
  supported: boolean;
  operations: RuntimeControlOperation[];
}

export interface RuntimeDynamicToolCapabilities {
  mode: RuntimeDynamicToolMode;
}

export interface RuntimeExecutionCapabilities {
  mode: RuntimeExecutionMode;
}

export interface RuntimeSessionStateCapabilities {
  mode: RuntimeSessionStateMode;
  requiresCwdMatch?: boolean;
}

export interface RuntimeUsageCapabilities {
  semantics: RuntimeUsageSemantics;
}

export interface RuntimeToolCapabilities {
  permissionMode: RuntimeToolPermissionMode;
  accessRequirement: RuntimeToolAccessRequirement;
  supportsParallelCalls: boolean;
}

export interface RuntimeSystemPromptCapabilities {
  mode: RuntimeSystemPromptMode;
}

export interface RuntimeTerminalEventCapabilities {
  guarantee: RuntimeTerminalEventGuarantee;
}

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
  hostServices?: RuntimeHostServices;
}

export interface RuntimePrepareSessionResult {
  env?: Record<string, string>;
  startRequest?: Partial<Pick<RuntimeStartRequest, "approveRuntimeRequest" | "dynamicTools" | "handleRuntimeToolCall">>;
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
  approveRuntimeRequest?: RuntimeApprovalHandler;
  dynamicTools?: RuntimeDynamicToolSpec[];
  handleRuntimeToolCall?: RuntimeDynamicToolCallHandler;
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
      type: "approval.requested";
      approval: RuntimeApprovalEvent;
      rawEvent?: Record<string, unknown>;
    } & RuntimeEventBase)
  | ({
      type: "approval.resolved";
      approval: RuntimeApprovalEvent;
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
  control?(request: RuntimeControlRequest): Promise<RuntimeControlResult>;
}

export interface RuntimeCapabilities {
  runtimeControl: RuntimeControlCapabilities;
  dynamicTools: RuntimeDynamicToolCapabilities;
  execution: RuntimeExecutionCapabilities;
  sessionState: RuntimeSessionStateCapabilities;
  usage: RuntimeUsageCapabilities;
  tools: RuntimeToolCapabilities;
  systemPrompt: RuntimeSystemPromptCapabilities;
  terminalEvents: RuntimeTerminalEventCapabilities;
  supportsSessionResume: boolean;
  supportsSessionFork: boolean;
  supportsPartialText: boolean;
  supportsToolHooks: boolean;
  supportsHostSessionHooks?: boolean;
  supportsPlugins: boolean;
  supportsMcpServers: boolean;
  supportsRemoteSpawn: boolean;
  legacyEventTopicSuffix?: string;
  toolAccessRequirement?: RuntimeToolAccessRequirement;
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
