import { StringCodec } from "nats";
import { nats, getNats } from "./nats.js";
import {
  SESSION_STREAM,
  getConsumerName,
  ensureSessionConsumer,
  ensureSessionPromptsStream,
} from "./omni/session-stream.js";
import { logger } from "./utils/logger.js";
import type { Config } from "./utils/config.js";
import { saveMessage, backfillProviderSessionId, close as closeDb } from "./db.js";
import { buildSystemPrompt, SILENT_TOKEN } from "./prompt-builder.js";
import {
  getOrCreateSession,
  getSession,
  getSessionByName,
  clearProviderSession,
  updateProviderSession,
  updateRuntimeProviderState,
  updateTokens,
  updateSessionSource,
  updateSessionContext,
  updateSessionDisplayName,
  closeRouterDb,
  deleteSession,
  expandHome,
  getAnnounceCompaction,
  getAccountForAgent,
  dbInsertCostEvent,
  type AgentConfig,
  type ContextRecord,
  type SessionEntry,
} from "./router/index.js";
import { calculateCost } from "./constants.js";
import { configStore } from "./config-store.js";
import { runWithContext } from "./cli/context.js";
import { getAllCommandClasses, createSdkTools } from "./cli/tool-definitions.js";
import { extractTools, type ExportedTool, type ToolResult } from "./cli/tools-export.js";
import { HEARTBEAT_OK } from "./heartbeat/index.js";
import {
  checkDangerousPatterns,
  createBashPermissionHook,
  createToolPermissionHook,
  emitBashDeniedAudit,
  evaluateBashPermission,
  parseBashCommand,
  UNCONDITIONAL_BLOCKS,
} from "./bash/index.js";
import { createPreCompactHook } from "./hooks/index.js";
import { SANITIZED_ENV_VARS, createSanitizeBashHook } from "./hooks/sanitize-bash.js";
import { createSpecServer, isSpecModeActive, getSpecState } from "./spec/server.js";
import { getToolSafety } from "./hooks/tool-safety.js";
import { discoverPlugins } from "./plugins/index.js";
import { SESSION_MODEL_CHANGED_TOPIC, type SessionModelChangedEvent } from "./session-control.js";
import { delimiter, dirname, join } from "node:path";
import { createRemoteSpawn } from "./remote-spawn.js";
import { createNatsRemoteSpawn } from "./remote-spawn-nats.js";
import { agentCan, canWithCapabilityContext } from "./permissions/engine.js";
import {
  authorizeRuntimeContext,
  requestCascadingApproval,
  requestPollAnswer,
  type ApprovalTarget,
} from "./approval/service.js";
import {
  DEFAULT_DELIVERY_BARRIER,
  chooseMoreUrgentBarrier,
  describeDeliveryBarrier,
  type DeliveryBarrier,
} from "./delivery-barriers.js";
import {
  dbHasActiveTaskForSession,
  dbMarkTaskAcceptedForSession,
  dbResolveActiveTaskBindingForSession,
} from "./tasks/task-db.js";
import { resolveTaskProfileForTask } from "./tasks/profiles.js";
import { resolveTaskRuntimeOptions } from "./tasks/runtime-options.js";
import { emitTaskEvent } from "./tasks/service.js";
import type { TaskRuntimeOptions, TaskRuntimeResolution } from "./tasks/types.js";
import {
  DEFAULT_RUNTIME_PROVIDER_ID,
  assertRuntimeCompatibility,
  createRuntimeContext,
  createRuntimeProvider,
  snapshotAgentCapabilities,
  type RuntimeApprovalResult,
  type RuntimeCapabilities,
  type RuntimeCapabilityAuthorizationResult,
  type RuntimeCommandAuthorizationRequest,
  type RuntimeControlRequest,
  type RuntimeControlResult,
  type RuntimeDynamicToolCallContentItem,
  type RuntimeDynamicToolExecutionOptions,
  type RuntimeDynamicToolCallRequest,
  type RuntimeDynamicToolCallResult,
  type RuntimeDynamicToolSpec,
  type RuntimeEventMetadata,
  type RuntimeHostServices,
  type RuntimeProviderId,
  type RuntimeSessionHandle,
  type RuntimeStartRequest,
  type RuntimeToolUseAuthorizationRequest,
  type RuntimeUserInputRequest,
  type RuntimeToolAccessMode,
} from "./runtime/index.js";

const log = logger.child("bot");

const MAX_OUTPUT_LENGTH = 1000;
const MAX_PAYLOAD_BYTES = 60000; // keep payloads reasonable
const MAX_CONCURRENT_SESSIONS = 30;
const TASK_RUNTIME_ENV_VARS = [
  "RAVI_TASK_ID",
  "RAVI_TASK_PROFILE_ID",
  "RAVI_PARENT_TASK_ID",
  "RAVI_TASK_SESSION",
  "RAVI_TASK_WORKSPACE",
];

function truncateOutput(output: unknown): unknown {
  if (typeof output === "string" && output.length > MAX_OUTPUT_LENGTH) {
    return output.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]`;
  }
  if (Array.isArray(output)) {
    return output.map((item) => {
      if (item?.type === "text" && typeof item?.text === "string" && item.text.length > MAX_OUTPUT_LENGTH) {
        return { ...item, text: item.text.slice(0, MAX_OUTPUT_LENGTH) + `... [truncated]` };
      }
      return item;
    });
  }
  return output;
}

const MAX_TURN_FAILURE_LOG_DETAIL = 1800;
const MAX_TURN_FAILURE_RESPONSE = 320;

function truncateLogDetail(value: unknown, maxLength = MAX_TURN_FAILURE_LOG_DETAIL): string | undefined {
  if (value === undefined || value === null) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }

  return text.length > maxLength ? `${text.slice(0, maxLength - 15)}... [truncated]` : text;
}

function summarizeRuntimeFailureRawEvent(rawEvent?: Record<string, unknown>): Record<string, unknown> | undefined {
  if (!rawEvent) return undefined;

  const summary: Record<string, unknown> = {};
  for (const key of ["type", "subtype", "status", "error", "errors", "message", "result", "exitCode"]) {
    if (rawEvent[key] !== undefined) {
      summary[key] = truncateLogDetail(rawEvent[key]);
    }
  }

  return Object.keys(summary).length > 0 ? summary : undefined;
}

function formatRuntimeFailureDetails(event: { error: string; rawEvent?: Record<string, unknown> }): string | undefined {
  const parts: string[] = [];
  const rawEvent = event.rawEvent;

  if (rawEvent?.type !== undefined) parts.push(`raw.type=${String(rawEvent.type)}`);
  if (rawEvent?.subtype !== undefined) parts.push(`raw.subtype=${String(rawEvent.subtype)}`);
  if (rawEvent?.status !== undefined) parts.push(`raw.status=${String(rawEvent.status)}`);

  for (const key of ["error", "errors", "message", "result"]) {
    const detail = truncateLogDetail(rawEvent?.[key]);
    if (detail) parts.push(`raw.${key}=${detail}`);
  }

  return parts.length > 0 ? parts.join(" ") : undefined;
}

function isRecoverableInterruptionFailure(event: {
  error?: string;
  recoverable?: boolean;
  rawEvent?: Record<string, unknown>;
}): boolean {
  if (event.recoverable === false) return false;

  const details = [
    event.error,
    event.rawEvent?.error,
    event.rawEvent?.errors,
    event.rawEvent?.message,
    event.rawEvent?.result,
  ]
    .filter((value) => value !== undefined && value !== null)
    .map((value) => (typeof value === "string" ? value : JSON.stringify(value)))
    .join("\n")
    .toLowerCase();

  const hasAbortMarker =
    details.includes("request was aborted") ||
    details.includes("operation was aborted") ||
    details.includes("aborterror");
  const hasInterruptedDiagnostic =
    details.includes("[ede_diagnostic]") &&
    details.includes("result_type=user") &&
    details.includes("last_content_type=n/a") &&
    (details.includes("stop_reason=null") || details.includes("stop_reason=tool_use"));

  return hasAbortMarker || hasInterruptedDiagnostic;
}

function formatUserFacingTurnFailure(error: string): string {
  const firstLine = error
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean);
  const detail = firstLine ?? (error.trim() || "unknown error");
  const clipped =
    detail.length > MAX_TURN_FAILURE_RESPONSE
      ? `${detail.slice(0, MAX_TURN_FAILURE_RESPONSE - 15)}... [truncated]`
      : detail;
  return `Error: ${clipped}`;
}

/** Emit to NATS, truncating payload if it exceeds the size limit */
async function safeEmit(topic: string, data: Record<string, unknown>): Promise<void> {
  let json = JSON.stringify(data);
  if (json.length <= MAX_PAYLOAD_BYTES) {
    await nats.emit(topic, data);
    return;
  }
  // Truncate the largest string values until it fits
  const truncated: Record<string, unknown> = { ...data, _truncated: true };
  for (const key of Object.keys(truncated)) {
    const val = truncated[key];
    if (typeof val === "string" && val.length > MAX_OUTPUT_LENGTH) {
      truncated[key] = val.slice(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
    } else if (typeof val === "object" && val !== null) {
      const s = JSON.stringify(val);
      if (s.length > MAX_OUTPUT_LENGTH) {
        truncated[key] = s.slice(0, MAX_OUTPUT_LENGTH) + "... [truncated]";
      }
    }
  }
  json = JSON.stringify(truncated);
  if (json.length > MAX_PAYLOAD_BYTES) {
    // Still too big - emit minimal event
    await nats.emit(topic, { _truncated: true, type: (data as any).type ?? (data as any).event ?? "unknown" });
    return;
  }
  await nats.emit(topic, truncated);
}

async function* emptyRuntimeEvents(): AsyncGenerator<never> {}

function createPendingRuntimeHandle(provider: RuntimeProviderId): RuntimeSessionHandle {
  return {
    provider,
    events: emptyRuntimeEvents(),
    interrupt: async () => {},
  };
}

function resolveStoredRuntimeProvider(session: SessionEntry): RuntimeProviderId | undefined {
  if (session.runtimeProvider) {
    return session.runtimeProvider;
  }

  if (session.providerSessionId || session.sdkSessionId) {
    // Legacy sessions predate runtime_provider and belong to the default runtime.
    return DEFAULT_RUNTIME_PROVIDER_ID;
  }

  return undefined;
}

function hasUnrestrictedToolExecution(agentId: string): boolean {
  return (
    agentCan(agentId, "admin", "system", "*") ||
    (agentCan(agentId, "use", "tool", "*") && agentCan(agentId, "execute", "executable", "*"))
  );
}

function hasUnrestrictedToolSurface(agentId: string): boolean {
  return agentCan(agentId, "admin", "system", "*") || agentCan(agentId, "use", "tool", "*");
}

function getRuntimeToolAccessMode(capabilities: RuntimeCapabilities, agentId: string): RuntimeToolAccessMode {
  if (capabilities.toolAccessRequirement === "tool_surface") {
    return hasUnrestrictedToolSurface(agentId) ? "unrestricted" : "restricted";
  }

  return hasUnrestrictedToolExecution(agentId) ? "unrestricted" : "restricted";
}

const RUNTIME_BUILTIN_EXECUTABLES = new Set(["ravi"]);
let cachedRuntimeDynamicTools: ExportedTool[] | null = null;
let cachedRuntimeDynamicToolSpecs: RuntimeDynamicToolSpec[] | null = null;

function getRuntimeDynamicToolDefinitions(): ExportedTool[] {
  if (!cachedRuntimeDynamicTools) {
    cachedRuntimeDynamicTools = extractTools(getAllCommandClasses());
  }
  return cachedRuntimeDynamicTools;
}

function getRuntimeDynamicToolSpecs(): RuntimeDynamicToolSpec[] {
  if (!cachedRuntimeDynamicToolSpecs) {
    cachedRuntimeDynamicToolSpecs = createSdkTools(getAllCommandClasses()).map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    }));
  }
  return cachedRuntimeDynamicToolSpecs;
}

function getRuntimeDynamicToolSpecsForContext(context: ContextRecord): RuntimeDynamicToolSpec[] {
  const allowedToolNames = new Set(
    getRuntimeDynamicToolDefinitions()
      .filter((tool) => canAdvertiseRuntimeDynamicTool(context, tool))
      .map((tool) => tool.name),
  );

  return getRuntimeDynamicToolSpecs().filter((tool) => allowedToolNames.has(tool.name));
}

function canAdvertiseRuntimeDynamicTool(context: ContextRecord, tool: ExportedTool): boolean {
  if (!canWithCapabilityContext(context, "use", "tool", tool.name)) {
    return false;
  }

  const scope = tool.metadata.scope ?? "admin";
  switch (scope) {
    case "open":
    case "resource":
      return true;
    case "superadmin":
      return canWithCapabilityContext(context, "admin", "system", "*");
    case "writeContacts":
      return canWithCapabilityContext(context, "write_contacts", "system", "*");
    case "admin":
      return (
        canWithCapabilityContext(context, "execute", "group", tool.metadata.group) ||
        canWithCapabilityContext(context, "execute", "group", `${tool.metadata.group}_${tool.metadata.command}`)
      );
    default:
      return false;
  }
}

function createRuntimeHostServices(options: {
  context: ContextRecord;
  agentId: string;
  sessionName: string;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  toolContext: Record<string, unknown>;
}): RuntimeHostServices {
  return {
    authorizeCapability: (request) => authorizeRuntimeCapability(options.context, request),
    authorizeCommandExecution: (request) => authorizeRuntimeCommandExecution(options, request),
    authorizeToolUse: (request) => authorizeRuntimeToolUse(options, request),
    requestUserInput: (request) => requestRuntimeUserInput(options, request),
    listDynamicTools: () => getRuntimeDynamicToolSpecsForContext(options.context),
    executeDynamicTool: (request, executionOptions) => executeRuntimeDynamicTool(options, request, executionOptions),
  };
}

async function authorizeRuntimeCapability(
  context: ContextRecord,
  request: {
    permission: string;
    objectType: string;
    objectId: string;
    eventData?: Record<string, unknown>;
  },
): Promise<RuntimeCapabilityAuthorizationResult> {
  return authorizeRuntimeContext({
    context,
    permission: request.permission,
    objectType: request.objectType,
    objectId: request.objectId,
    eventData: request.eventData,
  });
}

async function executeRuntimeDynamicTool(
  options: {
    context: ContextRecord;
    agentId: string;
    sessionName: string;
    toolContext: Record<string, unknown>;
  },
  request: RuntimeDynamicToolCallRequest,
  executionOptions?: RuntimeDynamicToolExecutionOptions,
): Promise<RuntimeDynamicToolCallResult> {
  const tool = getRuntimeDynamicToolDefinitions().find((candidate) => candidate.name === request.toolName);
  if (!tool) {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: `Unknown Ravi dynamic tool: ${request.toolName}` }],
    };
  }

  const authorization = await authorizeRuntimeDynamicToolCall(options, tool, executionOptions?.eventData);
  if (!authorization.allowed) {
    return {
      success: false,
      contentItems: [{ type: "inputText", text: authorization.reason ?? `${request.toolName} permission denied.` }],
    };
  }

  const args = normalizeDynamicToolArguments(request.arguments);
  const result = await runWithContext(options.toolContext, () => tool.handler(args));
  return buildRuntimeDynamicToolResult(result);
}

async function authorizeRuntimeDynamicToolCall(
  options: { context: ContextRecord; agentId: string; sessionName: string },
  tool: ExportedTool,
  eventData: Record<string, unknown> | undefined,
): Promise<{ allowed: boolean; reason?: string }> {
  const toolAuthorization = await authorizeRuntimeContext({
    context: options.context,
    permission: "use",
    objectType: "tool",
    objectId: tool.name,
    eventData,
  });
  if (!toolAuthorization.allowed) {
    return { allowed: false, reason: toolAuthorization.reason ?? `${tool.name} tool permission denied.` };
  }

  return authorizeRuntimeDynamicToolScope(options, tool, eventData);
}

async function authorizeRuntimeDynamicToolScope(
  options: { context: ContextRecord },
  tool: ExportedTool,
  eventData?: Record<string, unknown>,
): Promise<{ allowed: boolean; reason?: string }> {
  const scope = tool.metadata.scope ?? "admin";
  if (scope === "open" || scope === "resource") {
    return { allowed: true };
  }

  if (scope === "superadmin") {
    const result = await authorizeRuntimeContext({
      context: options.context,
      permission: "admin",
      objectType: "system",
      objectId: "*",
      eventData,
    });
    return result.allowed
      ? { allowed: true }
      : { allowed: false, reason: result.reason ?? "Superadmin permission denied." };
  }

  if (scope === "writeContacts") {
    const result = await authorizeRuntimeContext({
      context: options.context,
      permission: "write_contacts",
      objectType: "system",
      objectId: "*",
      eventData,
    });
    return result.allowed
      ? { allowed: true }
      : { allowed: false, reason: result.reason ?? "Contact write permission denied." };
  }

  const group = tool.metadata.group;
  const command = tool.metadata.command;
  if (canWithCapabilityContext(options.context, "execute", "group", group)) {
    return { allowed: true };
  }

  const result = await authorizeRuntimeContext({
    context: options.context,
    permission: "execute",
    objectType: "group",
    objectId: `${group}_${command}`,
    eventData,
  });
  return result.allowed
    ? { allowed: true }
    : { allowed: false, reason: result.reason ?? `CLI tool permission denied: ${group}_${command}` };
}

function normalizeDynamicToolArguments(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function buildRuntimeDynamicToolResult(result: ToolResult): RuntimeDynamicToolCallResult {
  return {
    success: result.isError !== true,
    contentItems: toDynamicToolContentItems(result.content),
  };
}

function toDynamicToolContentItems(content: ToolResult["content"]): RuntimeDynamicToolCallContentItem[] {
  const items: RuntimeDynamicToolCallContentItem[] = [];
  for (const item of content) {
    if (item.type === "text") {
      items.push({ type: "inputText", text: item.text });
    }
  }

  return items.length > 0 ? items : [{ type: "inputText", text: "(no output)" }];
}

async function authorizeRuntimeCommandExecution(
  options: {
    context: ContextRecord;
    agentId: string;
    sessionName: string;
  },
  request: RuntimeCommandAuthorizationRequest,
): Promise<RuntimeApprovalResult> {
  const command = request.command;
  if (!command.trim()) {
    return { approved: false, reason: "Runtime command approval request did not include a command." };
  }

  const eventData = request.eventData;
  const buildBashContext = () => ({
    agentId: options.agentId,
    ...(options.context.sessionKey ? { sessionKey: options.context.sessionKey } : {}),
    sessionName: options.context.sessionName ?? options.sessionName,
    capabilities: options.context.capabilities,
  });

  const preliminary = evaluateBashPermission(command, buildBashContext());
  if (!preliminary.allowed && preliminary.denialType === "env_spoofing") {
    emitBashDeniedAudit(command, preliminary, options.agentId);
    return { approved: false, reason: preliminary.reason ?? "Command denied by Ravi policy." };
  }

  const dangerous = checkDangerousPatterns(command);
  if (!dangerous.safe) {
    return { approved: false, reason: dangerous.reason ?? "Command denied by Ravi policy." };
  }

  const parsed = parseBashCommand(command);
  if (!parsed.success) {
    return { approved: false, reason: parsed.error ?? "Failed to parse command for approval." };
  }

  let inherited = true;
  const toolAuthorization = await authorizeRuntimeContext({
    context: options.context,
    permission: "use",
    objectType: "tool",
    objectId: "Bash",
    eventData,
  });
  if (!toolAuthorization.allowed) {
    return {
      approved: false,
      reason: toolAuthorization.reason ?? "Bash tool permission denied.",
    };
  }
  inherited = inherited && toolAuthorization.inherited;

  if (!canWithCapabilityContext(options.context, "execute", "executable", "*")) {
    for (const executable of parsed.executables) {
      if (UNCONDITIONAL_BLOCKS.has(executable)) {
        return { approved: false, reason: `${executable} is blocked by Ravi command policy.` };
      }
      if (RUNTIME_BUILTIN_EXECUTABLES.has(executable)) {
        continue;
      }

      const executableAuthorization = await authorizeRuntimeContext({
        context: options.context,
        permission: "execute",
        objectType: "executable",
        objectId: executable,
        eventData: {
          ...eventData,
          runtimeExecutable: executable,
        },
      });
      if (!executableAuthorization.allowed) {
        return {
          approved: false,
          reason: executableAuthorization.reason ?? `Executable permission denied: ${executable}`,
        };
      }
      inherited = inherited && executableAuthorization.inherited;
    }
  }

  const afterExecutableApproval = evaluateBashPermission(command, buildBashContext());
  if (!afterExecutableApproval.allowed && afterExecutableApproval.denialType === "session_scope") {
    const target = extractRaviSessionTarget(command);
    if (target) {
      const sessionAuthorization = await authorizeRuntimeContext({
        context: options.context,
        permission: "access",
        objectType: "session",
        objectId: target,
        eventData: {
          ...eventData,
          runtimeSessionTarget: target,
        },
      });
      if (!sessionAuthorization.allowed) {
        emitBashDeniedAudit(command, afterExecutableApproval, options.agentId);
        return {
          approved: false,
          reason: sessionAuthorization.reason ?? afterExecutableApproval.reason ?? `Session access denied: ${target}`,
        };
      }
      inherited = inherited && sessionAuthorization.inherited;
    }
  }

  const finalDecision = evaluateBashPermission(command, buildBashContext());
  if (!finalDecision.allowed) {
    emitBashDeniedAudit(command, finalDecision, options.agentId);
    return { approved: false, reason: finalDecision.reason ?? "Command denied by Ravi policy." };
  }

  return { approved: true, inherited, updatedInput: request.input };
}

async function authorizeRuntimeToolUse(
  options: { context: ContextRecord },
  request: RuntimeToolUseAuthorizationRequest,
): Promise<RuntimeApprovalResult> {
  const result = await authorizeRuntimeContext({
    context: options.context,
    permission: "use",
    objectType: "tool",
    objectId: request.toolName,
    eventData: request.eventData,
  });

  if (!result.allowed) {
    return { approved: false, reason: result.reason ?? `${request.toolName} permission denied.` };
  }

  return {
    approved: true,
    inherited: result.inherited,
    updatedInput: request.input,
  };
}

async function requestRuntimeUserInput(
  options: {
    agentId: string;
    sessionName: string;
    resolvedSource?: ApprovalTarget;
    approvalSource?: ApprovalTarget;
  },
  request: RuntimeUserInputRequest,
): Promise<RuntimeApprovalResult> {
  const questions = request.questions;
  const targetSource = options.resolvedSource ?? options.approvalSource;
  if (!targetSource || questions.length === 0) {
    return { approved: true, answers: {}, inherited: true };
  }

  const eventData = request.eventData;
  const isDelegated = !options.resolvedSource && !!options.approvalSource;
  nats
    .emit("ravi.approval.request", {
      type: "question",
      sessionName: options.sessionName,
      agentId: options.agentId,
      delegated: isDelegated,
      channel: targetSource.channel,
      chatId: targetSource.chatId,
      questionCount: questions.length,
      timestamp: Date.now(),
      ...eventData,
    })
    .catch(() => {});

  const answers: Record<string, string> = {};

  for (const question of questions) {
    const optionLabels = question.options?.map((option) => option.label).filter(Boolean) ?? [];
    if (optionLabels.length === 0) {
      continue;
    }

    const hasDescriptions = question.options?.some((option) => option.description) ?? false;
    let pollName = isDelegated ? `[${options.agentId}] ${question.question}` : question.question;
    if (hasDescriptions) {
      const descLines = (question.options ?? [])
        .map((option) => (option.description ? `• ${option.label} — ${option.description}` : `• ${option.label}`))
        .join("\n");
      pollName += "\n\n" + descLines;
    }
    pollName += "\n(responda a mensagem para outro)";

    const result = await requestPollAnswer(targetSource, pollName, optionLabels, {
      selectableCount: question.multiSelect ? optionLabels.length : 1,
    });

    const answerKey = question.id ?? question.question;
    answers[answerKey] = "selectedLabels" in result ? result.selectedLabels.join(", ") : result.freeText;
  }

  nats
    .emit("ravi.approval.response", {
      type: "question",
      sessionName: options.sessionName,
      agentId: options.agentId,
      approved: true,
      answers,
      timestamp: Date.now(),
      ...eventData,
    })
    .catch(() => {});

  return { approved: true, answers };
}

function extractRaviSessionTarget(command: string): string | null {
  const match = command.match(
    /(?:^|\s|&&|\|\||;)\s*(?:\S+=\S+\s+)*(?:\/\S+\/)?ravi\s+[\w-]+\s+[\w-]+\s+(?:(?:-\w+\s+\S+\s+)*)["']?([^"'\s]+)/,
  );
  return match?.[1] ?? null;
}

function resolveCanonicalRaviCliPath(): string | null {
  const explicit = process.env.RAVI_BIN?.trim();
  if (explicit) {
    return explicit;
  }

  const bundlePath = process.argv[1];
  if (!bundlePath) {
    return null;
  }

  return join(dirname(dirname(dirname(bundlePath))), "bin", "ravi");
}

function prependPathEntry(currentPath: string | undefined, entry: string): string {
  const parts = (currentPath ?? "")
    .split(delimiter)
    .map((part) => part.trim())
    .filter((part) => part.length > 0 && part !== entry);
  return [entry, ...parts].join(delimiter);
}

function buildRuntimeEnv(
  baseEnv: Record<string, string>,
  raviEnv: Record<string, string>,
  providerEnv: Record<string, string> | undefined,
  capabilities: ReturnType<ReturnType<typeof createRuntimeProvider>["getCapabilities"]>,
): Record<string, string> {
  const sanitizedBaseEnv = { ...baseEnv };
  for (const key of TASK_RUNTIME_ENV_VARS) {
    delete sanitizedBaseEnv[key];
  }

  const runtimeEnv = {
    ...sanitizedBaseEnv,
    ...raviEnv,
    ...(providerEnv ?? {}),
  };
  const canonicalRaviCliPath = resolveCanonicalRaviCliPath();
  if (canonicalRaviCliPath) {
    runtimeEnv.RAVI_BIN = canonicalRaviCliPath;
    runtimeEnv.PATH = prependPathEntry(runtimeEnv.PATH, dirname(canonicalRaviCliPath));
  }

  if (!capabilities.supportsToolHooks) {
    for (const key of SANITIZED_ENV_VARS) {
      delete runtimeEnv[key];
    }
  }

  return runtimeEnv;
}

function buildTaskRuntimeEnv(
  sessionName: string,
  sessionCwd: string,
  taskBarrierTaskId?: string,
): Record<string, string> {
  const normalizedTaskId = normalizePromptTaskBarrierTaskId(taskBarrierTaskId);
  if (!normalizedTaskId) {
    return {};
  }

  const binding = dbResolveActiveTaskBindingForSession(sessionName, normalizedTaskId);
  if (!binding) {
    return {};
  }

  const { task, assignment } = binding;
  const workspaceRoot =
    (assignment.worktree?.mode === "path" ? assignment.worktree.path : undefined) ??
    (task.worktree?.mode === "path" ? task.worktree.path : undefined) ??
    task.taskDir ??
    sessionCwd;

  return {
    RAVI_TASK_ID: task.id,
    ...(task.profileId ? { RAVI_TASK_PROFILE_ID: task.profileId } : {}),
    ...(task.parentTaskId ? { RAVI_PARENT_TASK_ID: task.parentTaskId } : {}),
    RAVI_TASK_SESSION: assignment.sessionName,
    ...(workspaceRoot ? { RAVI_TASK_WORKSPACE: workspaceRoot } : {}),
  };
}

function normalizePromptTaskBarrierTaskId(taskBarrierTaskId?: string): string | undefined {
  const normalized = taskBarrierTaskId?.trim();
  return normalized ? normalized : undefined;
}

/** Message context for structured prompts */
export interface MessageContext {
  channelId: string;
  channelName: string;
  accountId: string;
  chatId: string;
  messageId: string;
  senderId: string;
  senderName?: string;
  senderPhone?: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  isMentioned?: boolean;
  botTag?: string;
  timestamp: number;
}

/** Stable channel/group metadata persisted in session for cross-send reuse */
export interface ChannelContext {
  channelId: string;
  channelName: string;
  isGroup: boolean;
  groupName?: string;
  groupId?: string;
  groupMembers?: string[];
  botTag?: string;
}

/** Debounce state for grouping messages */
interface DebounceState {
  messages: Array<{ prompt: PromptMessage; source?: MessageTarget }>;
  timer: ReturnType<typeof setTimeout>;
  debounceMs: number;
}

/** Message routing target */
export interface MessageTarget {
  channel: string;
  accountId: string;
  chatId: string;
  /** Thread/topic ID for platforms that support it (Telegram topics, Slack threads, Discord threads) */
  threadId?: string;
}

/** Prompt message structure */
export interface PromptMessage {
  prompt: string;
  /**
   * Message delivery barrier:
   * - immediate_interrupt: interrupt current turn as soon as it is safe
   * - after_tool: wait for tool/compaction startup barriers, then preempt text response
   * - after_response: wait until the current turn completes
   * - after_task: wait until the session has no active task assignment
   */
  deliveryBarrier?: DeliveryBarrier;
  /** Task ID exempted from after_task blocking (used by task dispatch to avoid self-deadlock) */
  taskBarrierTaskId?: string;
  source?: MessageTarget;
  context?: MessageContext;
  /** Approval routing: channel to send approval requests when agent has no direct channel */
  _approvalSource?: MessageTarget;
}

/** Response message structure */
export interface ResponseMessage {
  response?: string;
  error?: string;
  target?: MessageTarget;
  /** Unique emit ID to detect ghost/duplicate responses */
  _emitId?: string;
  usage?: {
    input_tokens: number;
    output_tokens: number;
  };
}

/** Streaming session — persistent SDK subprocess that accepts messages via AsyncGenerator */
interface StreamingSession {
  /** The SDK query handle */
  queryHandle: RuntimeSessionHandle;
  /** True while the runtime provider is still bootstrapping */
  starting: boolean;
  /** Abort controller to kill the subprocess */
  abortController: AbortController;
  /** Resolve function to unblock the generator when waiting between turns */
  pushMessage: ((msg: UserMessage | null) => void) | null;
  /** Sticky wake-up flag for queue releases that happen between generator loops */
  pendingWake: boolean;
  /** Queue of messages — stays in queue until turn completes without interrupt */
  pendingMessages: UserMessage[];
  /** Current response source for routing */
  currentSource?: MessageTarget;
  /** Runtime model currently assigned to this live stream */
  currentModel: string;
  /** Runtime effort currently assigned to this live stream */
  currentEffort?: TaskRuntimeOptions["effort"];
  /** Runtime thinking mode currently assigned to this live stream */
  currentThinking?: TaskRuntimeOptions["thinking"];
  /** Explicit task context used to start this runtime process, if any. */
  currentTaskBarrierTaskId?: string;
  /** Tool tracking */
  toolRunning: boolean;
  currentToolId?: string;
  currentToolName?: string;
  toolStartTime?: number;
  /** Activity tracking */
  lastActivity: number;
  /** Whether the event loop is done (session ended) */
  done: boolean;
  /** Whether the current turn was interrupted (discard response, keep queue) */
  interrupted: boolean;
  /** Whether a provider turn is currently active until a terminal event arrives */
  turnActive: boolean;
  /** Signal from result handler to unblock generator after turn completes */
  onTurnComplete: (() => void) | null;
  /** Flag: SDK returned "Prompt is too long" — session needs reset */
  _promptTooLong?: boolean;
  /** Whether the SDK is currently compacting (don't interrupt during compaction) */
  compacting: boolean;
  /** Tool safety classification — "safe" tools can be interrupted, "unsafe" cannot */
  currentToolSafety: "safe" | "unsafe" | null;
  /** Pending abort — set when abort is requested during an unsafe tool call */
  pendingAbort: boolean;
  /** Agent mode (e.g. "sentinel") — controls compaction announcements and system commands */
  agentMode?: string;
}

interface RuntimeControlNatsRequest {
  sessionName?: string;
  sessionKey?: string;
  request?: RuntimeControlRequest;
  replyTopic?: string;
}

/** User message format for the SDK streaming input */
interface UserMessage {
  type: "user";
  message: {
    role: "user";
    content: string;
  };
  session_id: string;
  parent_tool_use_id: string | null;
  deliveryBarrier?: DeliveryBarrier;
  taskBarrierTaskId?: string;
  pendingId?: string;
  queuedAt?: number;
}

export interface RaviBotOptions {
  config: Config;
}

/** Pending session start request — queued when concurrency limit is reached */
interface PendingStart {
  sessionName: string;
  prompt: PromptMessage;
  resolve: () => void;
}

export class RaviBot {
  private config: Config;
  private running = false;
  private streamingSessions = new Map<string, StreamingSession>();
  private debounceStates = new Map<string, DebounceState>();
  private promptSubscriptionActive = false;
  /** Cold-start prompts parked behind an active task before a runtime session exists */
  private deferredAfterTaskStarts = new Map<string, PromptMessage[]>();
  /** Queued session starts waiting for a concurrency slot */
  private pendingStarts: PendingStart[] = [];
  /** Messages stashed from aborted sessions — re-injected on next prompt */
  private stashedMessages = new Map<string, UserMessage[]>();
  /** Unique instance ID to trace responses back to this daemon instance */
  readonly instanceId = Math.random().toString(36).slice(2, 8);
  /** Subscriber health: incremented on every prompt received */
  private promptsReceived = 0;
  /** Subscriber health: watchdog timer */
  private subscriberHealthTimer: ReturnType<typeof setInterval> | null = null;
  /** Resolves when the JetStream consumer is active and ready to receive messages */
  readonly consumerReady: Promise<void>;
  private resolveConsumerReady!: () => void;
  private consumerReadyResolved = false;

  constructor(options: RaviBotOptions) {
    this.consumerReady = new Promise<void>((resolve) => {
      this.resolveConsumerReady = resolve;
    });
    this.config = options.config;
    logger.setLevel(options.config.logLevel);
  }

  private markConsumerReady(): void {
    if (this.consumerReadyResolved) return;
    this.consumerReadyResolved = true;
    this.resolveConsumerReady();
  }

  private async delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private isPromptBootstrapError(err: unknown): boolean {
    const message = err instanceof Error ? err.message.toLowerCase() : String(err).toLowerCase();
    return message.includes("stream not found") || message.includes("consumer not found");
  }

  /** Mark a streaming session as finished and wake any idle waiters. */
  private signalStreamingSessionShutdown(session: StreamingSession): void {
    session.done = true;
    session.starting = false;

    session.queryHandle.interrupt().catch(() => {});

    if (session.pushMessage) {
      session.pushMessage(null as any);
      session.pushMessage = null;
    }

    if (session.onTurnComplete) {
      session.onTurnComplete();
      session.onTurnComplete = null;
    }

    if (!session.abortController.signal.aborted) {
      session.abortController.abort();
    }
  }

  async start(): Promise<void> {
    log.info("Starting Ravi bot...", { pid: process.pid, instanceId: this.instanceId });
    this.running = true;
    this.subscribeToPrompts();
    this.subscribeToSessionAborts();
    this.subscribeToSessionModelChanges();
    this.subscribeToRuntimeControls();
    this.subscribeToTaskEvents();
    this.startSubscriberHealthCheck();
    void this.recoverActiveTasksAfterRestart();
    log.info("Ravi bot started", {
      pid: process.pid,
      instanceId: this.instanceId,
      agents: Object.keys(configStore.getConfig().agents),
    });
  }

  private async recoverActiveTasksAfterRestart(): Promise<void> {
    try {
      const { recoverActiveTasksAfterRestart } = await import("./tasks/service.js");
      const recovery = await recoverActiveTasksAfterRestart();
      if (recovery.recoveredTaskIds.length === 0 && recovery.skipped.length === 0) {
        return;
      }
      log.info("Recovered active tasks after restart", {
        recovered: recovery.recoveredTaskIds,
        skipped: recovery.skipped,
      });
    } catch (error) {
      log.error("Failed to recover active tasks after restart", { error });
    }
  }

  async stop(): Promise<void> {
    log.info("Stopping Ravi bot...");
    this.running = false;

    // Stop subscriber health check
    if (this.subscriberHealthTimer) {
      clearInterval(this.subscriberHealthTimer);
      this.subscriberHealthTimer = null;
    }

    // Clear pending session start queue
    if (this.pendingStarts.length > 0) {
      log.info("Clearing pending session starts", { count: this.pendingStarts.length });
      this.pendingStarts.length = 0;
    }

    // Abort ALL streaming sessions
    if (this.streamingSessions.size > 0) {
      log.info("Aborting streaming sessions", {
        count: this.streamingSessions.size,
        sessions: [...this.streamingSessions.keys()],
      });
      for (const [sessionName, session] of this.streamingSessions) {
        log.info("Aborting streaming session", { sessionName });
        this.signalStreamingSessionShutdown(session);
      }
      this.streamingSessions.clear();
    }

    closeDb();
    closeRouterDb();
    log.info("Ravi bot stopped");
  }

  /**
   * Abort and remove a streaming session by key.
   * Used by /reset to kill the SDK process before deleting the DB entry.
   */
  /** Abort a streaming session by name. Used by /reset.
   *  If an unsafe tool is running, defers the abort until the tool completes. */
  public abortSession(sessionName: string): boolean {
    const allNames = [...this.streamingSessions.keys()];
    log.info("abortSession called", {
      sessionName,
      allNames,
      found: this.streamingSessions.has(sessionName),
    });
    const session = this.streamingSessions.get(sessionName);
    if (!session) return false;

    // If an unsafe tool is running, defer the abort
    if (session.toolRunning && session.currentToolSafety === "unsafe") {
      log.info("Deferring abort — unsafe tool running", {
        sessionName,
        tool: session.currentToolName,
      });
      session.pendingAbort = true;
      return true;
    }

    // Stash pending messages so they're re-injected on next prompt
    if (session.pendingMessages.length > 0) {
      log.info("Stashing aborted messages", { sessionName, count: session.pendingMessages.length });
      this.stashedMessages.set(
        sessionName,
        session.pendingMessages.map((message) => ({ ...message })),
      );
    }

    log.info("Aborting streaming session", { sessionName, done: session.done });
    this.signalStreamingSessionShutdown(session);
    this.streamingSessions.delete(sessionName);
    return true;
  }

  /**
   * Listen for session abort events (from /reset slash command).
   * Kills the streaming SDK process so it doesn't compact or respond after reset.
   */
  private async subscribeToSessionAborts(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of nats.subscribe("ravi.session.abort")) {
          if (!this.running) break;
          const data = event.data as { sessionKey?: string; sessionName?: string };
          // Try session name first (streaming sessions are keyed by name), then DB key
          const key = data.sessionName ?? data.sessionKey;
          if (!key) continue;
          const aborted = this.abortSession(key);
          log.info("Session abort request", { key, aborted });
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Session abort subscription error, reconnecting in 2s", { error: err });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private resolveStreamingControlSession(
    sessionName?: string,
    sessionKey?: string,
  ): { name: string; session: StreamingSession } | null {
    if (sessionName) {
      const direct = this.streamingSessions.get(sessionName);
      if (direct) {
        return { name: sessionName, session: direct };
      }
    }

    if (sessionKey) {
      const direct = this.streamingSessions.get(sessionKey);
      if (direct) {
        return { name: sessionKey, session: direct };
      }

      const stored = getSession(sessionKey);
      if (stored?.name) {
        const named = this.streamingSessions.get(stored.name);
        if (named) {
          return { name: stored.name, session: named };
        }
      }
    }

    if (sessionName) {
      const stored = getSessionByName(sessionName) ?? getSession(sessionName);
      if (stored?.sessionKey) {
        const byKey = this.streamingSessions.get(stored.sessionKey);
        if (byKey) {
          return { name: stored.name ?? stored.sessionKey, session: byKey };
        }
      }
    }

    if (sessionKey) {
      for (const [name, session] of this.streamingSessions) {
        const stored = getSessionByName(name);
        if (stored?.sessionKey === sessionKey) {
          return { name, session };
        }
      }
    }

    return null;
  }

  private async replyRuntimeControlError(replyTopic: string | undefined, error: string): Promise<void> {
    if (!replyTopic) {
      log.warn("Runtime control request failed without reply topic", { error });
      return;
    }
    await safeEmit(replyTopic, { error });
  }

  private async handleRuntimeControlRequest(data: RuntimeControlNatsRequest): Promise<void> {
    const { replyTopic, request } = data;
    if (!request?.operation) {
      await this.replyRuntimeControlError(replyTopic, "Runtime control request is missing an operation.");
      return;
    }

    const resolved = this.resolveStreamingControlSession(data.sessionName, data.sessionKey);
    if (!resolved) {
      await this.replyRuntimeControlError(
        replyTopic,
        `No active runtime session found for ${data.sessionName ?? data.sessionKey ?? "(unknown)"}.`,
      );
      return;
    }

    if (!resolved.session.queryHandle.control) {
      const result: RuntimeControlResult = {
        ok: false,
        operation: request.operation,
        state: {
          provider: resolved.session.queryHandle.provider,
          activeTurn: resolved.session.turnActive,
          supportedOperations: [],
        },
        error: `Runtime provider '${resolved.session.queryHandle.provider}' does not expose control operations.`,
      };
      if (replyTopic) {
        await safeEmit(replyTopic, { result });
      }
      return;
    }

    const result = await resolved.session.queryHandle.control(request);
    if (replyTopic) {
      await safeEmit(replyTopic, { result });
    }

    await safeEmit(`ravi.session.${resolved.name}.runtime`, {
      type: "runtime.control",
      provider: resolved.session.queryHandle.provider,
      operation: request.operation,
      ok: result.ok,
      error: result.error,
      state: result.state,
      timestamp: Date.now(),
    }).catch((error) => {
      log.warn("Failed to emit runtime control event", { sessionName: resolved.name, error });
    });
  }

  /**
   * Internal transparent controls for native runtime thread/turn semantics.
   * User-facing session/task/project abstractions remain the primary surface.
   */
  private async subscribeToRuntimeControls(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of nats.subscribe("ravi.session.runtime.control")) {
          if (!this.running) break;
          try {
            await this.handleRuntimeControlRequest(event.data as RuntimeControlNatsRequest);
          } catch (error) {
            const data = event.data as RuntimeControlNatsRequest;
            await this.replyRuntimeControlError(
              data?.replyTopic,
              error instanceof Error ? error.message : String(error),
            );
          }
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Runtime control subscription error, reconnecting in 2s", { error: err });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async subscribeToSessionModelChanges(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of nats.subscribe(SESSION_MODEL_CHANGED_TOPIC)) {
          if (!this.running) break;
          const data = event.data as Partial<SessionModelChangedEvent>;
          const effectiveModel = typeof data.effectiveModel === "string" ? data.effectiveModel.trim() : "";
          if (!effectiveModel) continue;

          const keys = [data.sessionName, data.sessionKey]
            .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
            .map((value) => value.trim());

          for (const key of new Set(keys)) {
            const status = await this.applySessionModelChange(key, effectiveModel);
            if (status !== "missing") {
              log.info("Session model change applied", { key, effectiveModel, status });
              break;
            }
          }
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Session model change subscription error, reconnecting in 2s", { error: err });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private async applySessionModelChange(
    sessionName: string,
    model: string,
  ): Promise<"missing" | "unchanged" | "applied" | "restart-next-turn"> {
    const streaming = this.streamingSessions.get(sessionName);
    if (!streaming || streaming.done) {
      return "missing";
    }
    if (streaming.currentModel === model) {
      return "unchanged";
    }

    if (typeof streaming.queryHandle.setModel === "function") {
      await streaming.queryHandle.setModel(model);
      streaming.currentModel = model;
      return "applied";
    }

    if (streaming.pendingMessages.length > 0) {
      this.stashedMessages.set(
        sessionName,
        streaming.pendingMessages.map((message) => ({ ...message })),
      );
    }
    streaming.currentModel = model;
    this.signalStreamingSessionShutdown(streaming);
    this.streamingSessions.delete(sessionName);
    return "restart-next-turn";
  }

  private resolvePromptRuntime(
    sessionName: string,
    prompt: PromptMessage,
    session: SessionEntry | null | undefined,
    agent: AgentConfig,
  ): TaskRuntimeResolution {
    const binding = prompt.taskBarrierTaskId
      ? dbResolveActiveTaskBindingForSession(sessionName, prompt.taskBarrierTaskId)
      : null;
    const profile = (() => {
      if (!binding) {
        return null;
      }
      try {
        return resolveTaskProfileForTask(binding.task);
      } catch (error) {
        log.warn("Task runtime profile unavailable while resolving runtime options", {
          sessionName,
          taskId: binding.task.id,
          profileId: binding.task.profileId,
          error,
        });
        return null;
      }
    })();
    return resolveTaskRuntimeOptions({
      task: binding?.task,
      assignment: binding?.assignment,
      profile,
      sessionModelOverride: session?.modelOverride,
      sessionThinkingLevel: session?.thinkingLevel,
      agentModel: agent.model,
      configModel: this.config.model,
    });
  }

  private runtimeRequiresRestart(
    streaming: StreamingSession,
    runtime: TaskRuntimeResolution,
    prompt: PromptMessage,
  ): boolean {
    return (
      streaming.currentTaskBarrierTaskId !== normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ||
      streaming.currentEffort !== runtime.options.effort ||
      streaming.currentThinking !== runtime.options.thinking
    );
  }

  private restartStreamingSessionForRuntimeChange(sessionName: string, streaming: StreamingSession): void {
    if (streaming.pendingMessages.length > 0) {
      this.stashedMessages.set(
        sessionName,
        streaming.pendingMessages.map((message) => ({ ...message })),
      );
    }
    this.signalStreamingSessionShutdown(streaming);
    this.streamingSessions.delete(sessionName);
  }

  /**
   * Wake sessions that were waiting on an active task barrier once the task ends.
   */
  private async subscribeToTaskEvents(): Promise<void> {
    while (this.running) {
      try {
        for await (const event of nats.subscribe("ravi.task.*.event")) {
          if (!this.running) break;
          const data = event.data as {
            type?: string;
            taskId?: string;
            assigneeSessionName?: string | null;
            assigneeAgentId?: string | null;
            task?: { title?: string | null; summary?: string | null };
            event?: { type?: string; sessionName?: string | null };
          };
          const type = data.event?.type ?? data.type;
          const sessionName =
            type === "task.done" || type === "task.failed"
              ? (data.assigneeSessionName ?? data.event?.sessionName ?? undefined)
              : (data.event?.sessionName ?? data.assigneeSessionName ?? undefined);
          if (type === "task.done" || type === "task.failed") {
            if (sessionName) {
              await this.startDeferredAfterTaskSessionIfDeliverable(sessionName);
              this.wakeStreamingSessionIfDeliverable(sessionName);
            }
          }
        }
      } catch (err) {
        if (!this.running) break;
        log.warn("Task event subscription error, reconnecting in 2s", { error: err });
        await new Promise((r) => setTimeout(r, 2000));
      }
    }
  }

  private getPromptDeliveryBarrier(prompt: PromptMessage): DeliveryBarrier {
    return prompt.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;
  }

  private createQueuedUserMessage(prompt: PromptMessage): UserMessage {
    return {
      type: "user",
      message: { role: "user", content: prompt.prompt },
      session_id: "",
      parent_tool_use_id: null,
      deliveryBarrier: this.getPromptDeliveryBarrier(prompt),
      taskBarrierTaskId: prompt.taskBarrierTaskId,
      pendingId: Math.random().toString(36).slice(2, 10),
      queuedAt: Date.now(),
    };
  }

  private isGeneratingText(session: StreamingSession): boolean {
    return !session.done && session.turnActive && !session.compacting && !session.toolRunning;
  }

  private canReleaseBarrier(
    sessionName: string,
    session: StreamingSession,
    barrier: DeliveryBarrier,
    taskBarrierTaskId?: string,
    hasActiveTask = dbHasActiveTaskForSession(sessionName, taskBarrierTaskId),
  ): boolean {
    switch (barrier) {
      case "immediate_interrupt":
        if (session.starting || session.compacting) return false;
        if (session.toolRunning && session.currentToolSafety === "unsafe") return false;
        return true;
      case "after_tool":
        return !session.starting && !session.compacting && !session.toolRunning;
      case "after_response":
        return !session.starting && !session.compacting && !session.toolRunning && !this.isGeneratingText(session);
      case "after_task":
        return (
          !hasActiveTask &&
          !session.starting &&
          !session.compacting &&
          !session.toolRunning &&
          !this.isGeneratingText(session)
        );
    }
  }

  private getDeliverablePendingMessages(sessionName: string, session: StreamingSession): UserMessage[] {
    if (session.pendingMessages.length === 0) {
      return [];
    }

    const activeTaskByExemption = new Map<string, boolean>();
    return session.pendingMessages.filter((message) =>
      this.canReleaseBarrier(
        sessionName,
        session,
        message.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER,
        message.taskBarrierTaskId,
        (() => {
          const key = message.taskBarrierTaskId ?? "__default__";
          if (!activeTaskByExemption.has(key)) {
            activeTaskByExemption.set(key, dbHasActiveTaskForSession(sessionName, message.taskBarrierTaskId));
          }
          return activeTaskByExemption.get(key) ?? false;
        })(),
      ),
    );
  }

  private hasDeliverablePendingMessages(sessionName: string, session: StreamingSession): boolean {
    return this.getDeliverablePendingMessages(sessionName, session).length > 0;
  }

  private shouldInterruptForIncoming(
    sessionName: string,
    session: StreamingSession,
    barrier: DeliveryBarrier,
    taskBarrierTaskId?: string,
  ): { interrupt: boolean; reason: string } {
    if (session.pushMessage) {
      return { interrupt: false, reason: "waiting" };
    }
    if (session.starting) {
      return { interrupt: false, reason: "starting" };
    }
    if (barrier === "after_task" && dbHasActiveTaskForSession(sessionName, taskBarrierTaskId)) {
      return { interrupt: false, reason: "active_task" };
    }
    if (session.compacting) {
      return { interrupt: false, reason: "compacting" };
    }
    if (session.toolRunning) {
      if (barrier !== "immediate_interrupt") {
        return { interrupt: false, reason: "tool" };
      }
      if (session.currentToolSafety === "unsafe") {
        return { interrupt: false, reason: "unsafe_tool" };
      }
      return { interrupt: true, reason: "safe_tool" };
    }
    if (barrier === "after_response" || barrier === "after_task") {
      return { interrupt: false, reason: "response" };
    }
    return { interrupt: true, reason: "response" };
  }

  private wakeStreamingSessionIfDeliverable(sessionName: string): void {
    const session = this.streamingSessions.get(sessionName);
    if (!session || !session.pushMessage) {
      if (session) {
        session.pendingWake = true;
      }
      return;
    }
    if (!this.hasDeliverablePendingMessages(sessionName, session)) {
      return;
    }
    const resolver = session.pushMessage;
    session.pushMessage = null;
    session.pendingWake = false;
    resolver(null);
  }

  private async startDeferredAfterTaskSessionIfDeliverable(sessionName: string): Promise<void> {
    const queued = this.deferredAfterTaskStarts.get(sessionName);
    if (!queued || queued.length === 0) {
      return;
    }
    const first = queued[0];
    if (!first) {
      this.deferredAfterTaskStarts.delete(sessionName);
      return;
    }
    if (dbHasActiveTaskForSession(sessionName, first.taskBarrierTaskId)) {
      return;
    }

    this.deferredAfterTaskStarts.delete(sessionName);

    if (this.streamingSessions.has(sessionName)) {
      for (const prompt of queued) {
        await this.handlePromptImmediate(sessionName, prompt);
      }
      return;
    }

    const [, ...rest] = queued;
    await this.startStreamingSession(sessionName, first);
    for (const prompt of rest) {
      await this.handlePromptImmediate(sessionName, prompt);
    }
  }

  /**
   * Periodic health check for the prompt subscriber.
   * If subscriber died without reconnecting, force a resubscribe.
   */
  private startSubscriberHealthCheck(): void {
    const HEALTH_CHECK_INTERVAL_MS = 30_000; // 30 seconds
    this.subscriberHealthTimer = setInterval(() => {
      if (!this.running) return;

      if (!this.promptSubscriptionActive) {
        log.warn("Subscriber health check: prompt subscription INACTIVE — forcing resubscribe", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.streamingSessions.size,
        });
        this.subscribeToPrompts();
      } else {
        log.debug("Subscriber health check: OK", {
          promptsReceived: this.promptsReceived,
          streamingSessions: this.streamingSessions.size,
        });
      }
    }, HEALTH_CHECK_INTERVAL_MS);
  }

  private async subscribeToPrompts(): Promise<void> {
    if (this.promptSubscriptionActive) {
      log.warn("Prompt subscription already active, skipping duplicate");
      return;
    }
    this.promptSubscriptionActive = true;

    log.info("Subscribing to SESSION_PROMPTS JetStream stream");

    const sc = StringCodec();

    try {
      const nc = getNats();
      const jsm = await nc.jetstreamManager();
      const js = nc.jetstream();

      const consumerName = getConsumerName();
      await ensureSessionPromptsStream();
      await ensureSessionConsumer(jsm);

      while (this.running) {
        try {
          const consumer = await js.consumers.get(SESSION_STREAM, consumerName);
          // expires: 2s — renew pull requests aggressively without tearing down the subscriber.
          const messages = await consumer.consume({ expires: 2000 });

          // Signal ready immediately — the pull request is sent synchronously by consume()
          this.markConsumerReady();

          for await (const msg of messages) {
            if (!this.running) {
              msg.nak();
              break;
            }

            let prompt: PromptMessage;
            try {
              const raw = sc.decode(msg.data);
              prompt = JSON.parse(raw) as PromptMessage;
            } catch (err) {
              log.error("Failed to parse session prompt", { error: err, subject: msg.subject });
              msg.nak();
              continue;
            }

            // Ack immediately — signals this daemon has claimed the prompt.
            // Another daemon won't receive it. If we crash mid-turn the user
            // will need to resend (acceptable trade-off vs blocking the stream).
            msg.ack();
            this.promptsReceived++;

            // Extract session name from subject: ravi.session.{name}.prompt
            const sessionName = msg.subject.split(".")[2];

            // Don't await - handle concurrently
            this.handlePrompt(sessionName, prompt).catch((err) => {
              log.error("Failed to handle prompt", err);
            });
          }

          if (!this.running) {
            break;
          }

          log.debug("Prompt pull window ended, renewing", { promptsReceived: this.promptsReceived });
        } catch (err) {
          if (!this.running) {
            break;
          }

          if (this.isPromptBootstrapError(err)) {
            log.warn("Prompt pull unavailable during bootstrap, re-ensuring stream/consumer", { error: err });
            await ensureSessionPromptsStream();
            await ensureSessionConsumer(jsm);
          } else {
            log.error("Prompt subscription error — will reconnect pull", { error: err });
          }

          await this.delay(1000);
        }
      }
    } catch (err) {
      log.error("Prompt subscription setup error", { error: err });
    } finally {
      this.promptSubscriptionActive = false;
      log.warn("Prompt subscription ended", { running: this.running, promptsReceived: this.promptsReceived });
      if (this.running) {
        setTimeout(() => this.subscribeToPrompts(), 1000);
      }
    }
  }

  private async handlePrompt(sessionName: string, prompt: PromptMessage): Promise<void> {
    const routerConfig = configStore.getConfig();

    // Look up session by name to get agentId
    // _agentId from heartbeat overrides DB (fixes race condition)
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

    // Use group-specific debounce when available and session is a group
    const isGroup = sessionEntry?.chatType === "group" || sessionName.includes(":group:");
    const debounceMs = isGroup && agent?.groupDebounceMs ? agent.groupDebounceMs : agent?.debounceMs;
    log.debug("handlePrompt", { sessionName, agentId, debounceMs, isGroup });

    // If debounce is configured, use debounce flow
    if (debounceMs && debounceMs > 0) {
      this.handlePromptWithDebounce(sessionName, prompt, debounceMs);
      return;
    }

    // No debounce - use immediate flow
    await this.handlePromptImmediate(sessionName, prompt);
  }

  private handlePromptWithDebounce(sessionName: string, prompt: PromptMessage, debounceMs: number): void {
    const existing = this.debounceStates.get(sessionName);

    if (existing) {
      log.debug("Debounce: adding message", { sessionName, count: existing.messages.length + 1 });
      clearTimeout(existing.timer);
      existing.messages.push({ prompt, source: prompt.source });
      existing.timer = setTimeout(() => this.flushDebounce(sessionName), debounceMs);
    } else {
      log.debug("Debounce: starting", { sessionName, debounceMs });
      const state: DebounceState = {
        messages: [{ prompt, source: prompt.source }],
        timer: setTimeout(() => this.flushDebounce(sessionName), debounceMs),
        debounceMs,
      };
      this.debounceStates.set(sessionName, state);
    }
  }

  private async flushDebounce(sessionName: string): Promise<void> {
    const state = this.debounceStates.get(sessionName);
    if (!state) return;

    this.debounceStates.delete(sessionName);

    // Combine all messages into one
    const combinedPrompt = state.messages.map((m) => m.prompt.prompt).join("\n\n");
    const lastSource = state.messages[state.messages.length - 1].source;
    const combinedBarrier = state.messages.reduce<DeliveryBarrier>(
      (current, entry) => chooseMoreUrgentBarrier(current, this.getPromptDeliveryBarrier(entry.prompt)),
      DEFAULT_DELIVERY_BARRIER,
    );

    log.info("Debounce: flushing", { sessionName, messageCount: state.messages.length });

    // Process the combined message
    await this.handlePromptImmediate(sessionName, {
      prompt: combinedPrompt,
      deliveryBarrier: combinedBarrier,
      source: lastSource,
    });
  }

  private async handlePromptImmediate(sessionName: string, prompt: PromptMessage): Promise<void> {
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];
    const requestedProvider: RuntimeProviderId = agent?.provider ?? DEFAULT_RUNTIME_PROVIDER_ID;
    const existing = this.streamingSessions.get(sessionName);

    if (existing && !existing.done) {
      if (existing.queryHandle.provider !== requestedProvider) {
        log.info("Streaming: restarting session after provider change", {
          sessionName,
          activeProvider: existing.queryHandle.provider,
          requestedProvider,
          queueSize: existing.pendingMessages.length,
        });

        if (existing.pendingMessages.length > 0) {
          this.stashedMessages.set(
            sessionName,
            existing.pendingMessages.map((message) => ({ ...message })),
          );
        }

        this.signalStreamingSessionShutdown(existing);
        this.streamingSessions.delete(sessionName);
      } else {
        const requestedRuntime = this.resolvePromptRuntime(sessionName, prompt, sessionEntry, agent);
        const requestedModel = requestedRuntime.options.model ?? this.config.model;
        if (this.runtimeRequiresRestart(existing, requestedRuntime, prompt)) {
          log.info("Streaming: restarting session after runtime task settings change", {
            sessionName,
            currentTaskBarrierTaskId: existing.currentTaskBarrierTaskId ?? null,
            requestedTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId) ?? null,
            currentEffort: existing.currentEffort ?? null,
            requestedEffort: requestedRuntime.options.effort ?? null,
            currentThinking: existing.currentThinking ?? null,
            requestedThinking: requestedRuntime.options.thinking ?? null,
          });
          this.restartStreamingSessionForRuntimeChange(sessionName, existing);
          await this.startStreamingSession(sessionName, prompt);
          return;
        }
        if (!existing.currentModel) {
          existing.currentModel = requestedModel;
        } else if (existing.currentModel !== requestedModel) {
          const modelStatus = await this.applySessionModelChange(sessionName, requestedModel);
          if (modelStatus === "restart-next-turn") {
            await this.startStreamingSession(sessionName, prompt);
            return;
          }
        }

        // Session alive — just push the new message into the generator
        log.info("Streaming: pushing message to existing session", { sessionName });
        // Resolve DB primary key for metadata updates
        if (sessionEntry) {
          this.updateSessionMetadata(sessionEntry.sessionKey, prompt);
        }
        saveMessage(sessionName, "user", prompt.prompt, sessionEntry?.providerSessionId ?? sessionEntry?.sdkSessionId);

        // Update source for response routing
        if (prompt.source) {
          existing.currentSource = prompt.source;
        }

        const userMsg: UserMessage = {
          ...this.createQueuedUserMessage(prompt),
        };

        // Always enqueue — messages only leave the queue when a turn completes without interrupt
        existing.pendingMessages.push(userMsg);

        const barrier = userMsg.deliveryBarrier ?? DEFAULT_DELIVERY_BARRIER;

        if (existing.pushMessage) {
          // Generator waiting between turns — wake it up to yield the queue
          if (this.hasDeliverablePendingMessages(sessionName, existing)) {
            log.info("Streaming: waking generator", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
            });
            const resolver = existing.pushMessage;
            existing.pushMessage = null;
            resolver(null); // wake-up signal
          } else {
            log.info("Streaming: queued without wake", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: "waiting_for_barrier",
            });
          }
        } else {
          const decision = this.shouldInterruptForIncoming(sessionName, existing, barrier, prompt.taskBarrierTaskId);
          if (!decision.interrupt) {
            log.info("Streaming: queueing (busy)", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: decision.reason,
              tool: existing.currentToolName,
            });
          } else {
            log.info("Streaming: interrupting turn", {
              sessionName,
              queueSize: existing.pendingMessages.length,
              barrier: describeDeliveryBarrier(barrier),
              reason: decision.reason,
            });
            existing.interrupted = true;
            existing.queryHandle.interrupt().catch(() => {});
          }
        }
        return;
      }
    }

    // No active session or previous one finished — start new streaming session
    if (existing?.done) {
      this.streamingSessions.delete(sessionName);
    }

    if (
      !existing &&
      this.getPromptDeliveryBarrier(prompt) === "after_task" &&
      dbHasActiveTaskForSession(sessionName, prompt.taskBarrierTaskId)
    ) {
      const queued = this.deferredAfterTaskStarts.get(sessionName) ?? [];
      queued.push(prompt);
      this.deferredAfterTaskStarts.set(sessionName, queued);
      log.info("Streaming: deferring cold start until task release", {
        sessionName,
        queued: queued.length,
      });
      return;
    }

    await this.startStreamingSession(sessionName, prompt);
  }

  /** Start a new streaming session with an AsyncGenerator that stays alive */
  private async startStreamingSession(sessionName: string, prompt: PromptMessage): Promise<void> {
    // Check concurrency limit — queue if at capacity
    if (this.streamingSessions.size >= MAX_CONCURRENT_SESSIONS) {
      log.warn("Session start queued — concurrency limit reached", {
        sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length + 1,
        max: MAX_CONCURRENT_SESSIONS,
      });
      await new Promise<void>((resolve) => {
        this.pendingStarts.push({ sessionName, prompt, resolve });
      });
      log.info("Pending session start resumed", {
        sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length,
        max: MAX_CONCURRENT_SESSIONS,
      });
    }

    // Look up agent from DB by session name
    // _agentId from heartbeat/cross-session overrides DB value (fixes race where bot
    // creates session with default agent before the runner's session is committed)
    const routerConfig = configStore.getConfig();
    const sessionEntry = getSessionByName(sessionName);
    const agentId = (prompt as any)._agentId ?? sessionEntry?.agentId ?? routerConfig.defaultAgent;
    const agent = routerConfig.agents[agentId] ?? routerConfig.agents[routerConfig.defaultAgent];

    if (!agent) {
      log.error("No agent found", { sessionName, agentId });
      return;
    }

    const agentCwd = expandHome(agent.cwd);
    const runtimeProviderId: RuntimeProviderId = agent.provider ?? DEFAULT_RUNTIME_PROVIDER_ID;
    const runtimeProvider = createRuntimeProvider(runtimeProviderId);
    const runtimeCapabilities = runtimeProvider.getCapabilities();

    // Session should already exist (created by resolver/CLI/heartbeat).
    // If not (e.g. direct NATS publish), create one using the name as both key and name.
    // If session exists but agent_id is wrong, getOrCreateSession with same key fixes it.
    let session: SessionEntry;
    if (sessionEntry && sessionEntry.agentId !== agentId) {
      // Fix agent_id mismatch (e.g. heartbeat created session with wrong agent)
      session = getOrCreateSession(sessionEntry.sessionKey, agentId, agentCwd);
    } else {
      session = sessionEntry ?? getOrCreateSession(sessionName, agentId, agentCwd, { name: sessionName });
    }
    const sessionCwd = expandHome(session.agentCwd);
    const dbSessionKey = session.sessionKey; // actual DB primary key
    const storedRuntimeSessionParams = session.runtimeSessionParams;
    const storedProviderSessionId =
      session.runtimeSessionDisplayId ?? session.providerSessionId ?? session.sdkSessionId;
    const storedRuntimeProvider = resolveStoredRuntimeProvider(session);
    const canResumeStoredSession =
      !!storedProviderSessionId &&
      storedRuntimeProvider === runtimeProviderId &&
      runtimeCapabilities.supportsSessionResume;

    if (storedProviderSessionId && !canResumeStoredSession) {
      log.info("Clearing stale provider session state", {
        sessionName,
        dbSessionKey,
        storedProvider: storedRuntimeProvider,
        requestedProvider: runtimeProviderId,
      });
      clearProviderSession(session.sessionKey);
      session.runtimeSessionParams = undefined;
      session.runtimeSessionDisplayId = undefined;
      session.providerSessionId = undefined;
      session.sdkSessionId = undefined;
      session.runtimeProvider = undefined;
    }

    log.info("startStreamingSession", {
      sessionName,
      dbSessionKey,
      provider: runtimeProviderId,
      providerSessionId: canResumeStoredSession ? storedProviderSessionId : undefined,
      willResume: canResumeStoredSession,
    });

    // Resolve source for response routing
    let resolvedSource = prompt.source;
    if (!resolvedSource && session.lastChannel && session.lastTo) {
      resolvedSource = {
        channel: session.lastChannel,
        accountId: session.lastAccountId ?? "",
        chatId: session.lastTo,
      };
    }
    // TUI prompts must not route to external channels
    if (resolvedSource?.channel === "tui") resolvedSource = undefined;

    // Approval source for cascading approvals (from delegating agent's channel)
    const approvalSource = prompt._approvalSource;

    this.updateSessionMetadata(dbSessionKey, prompt);
    saveMessage(sessionName, "user", prompt.prompt, canResumeStoredSession ? storedProviderSessionId : undefined);

    const runtimeResolution = this.resolvePromptRuntime(sessionName, prompt, session, agent);
    const model = runtimeResolution.options.model ?? this.config.model;

    // Build permission options
    // Use bypassPermissions so subagents (teams/tasks) inherit skip-all-permissions.
    // canUseTool callback still intercepts ExitPlanMode for reaction-based approval.
    // SDK tool permissions are enforced dynamically via PreToolUse hook (not disallowedTools)
    // so permission changes take effect immediately without session restart.
    const permissionOptions: Record<string, unknown> = {
      permissionMode: "bypassPermissions",
    };

    // Build system prompt
    const systemPromptAppend = buildSystemPrompt(agent.id, prompt.context, undefined, sessionName, {
      agentMode: agent.mode,
    });

    // Build provider-specific host hooks only for runtimes that consume this hook protocol.
    const hooks: Record<string, Array<{ matcher?: string; hooks: Array<(...args: any[]) => any> }>> = {};
    if (runtimeCapabilities.supportsHostSessionHooks) {
      const hookOpts = { getAgentId: () => agent.id };
      hooks.PreToolUse = [
        createToolPermissionHook(hookOpts), // SDK tools (dynamic REBAC)
        createBashPermissionHook(hookOpts), // Bash executables
        createSanitizeBashHook(), // Strip secrets from Bash env
      ];

      // Auto-approve all permission requests for subagents (teams/tasks).
      // The parent process uses canUseTool callback which isn't inherited by
      // subagent child processes. This hook ensures they don't hang waiting
      // for interactive approval in headless daemon mode.
      hooks.PermissionRequest = [
        {
          hooks: [
            async () => ({
              hookSpecificOutput: {
                hookEventName: "PermissionRequest" as const,
                decision: { behavior: "allow" as const },
              },
            }),
          ],
        },
      ];
      const preCompactHook = createPreCompactHook({ memoryModel: agent.memoryModel });
      hooks.PreCompact = [
        {
          hooks: [
            async (input, toolUseId, context) => {
              log.info("PreCompact hook CALLED by SDK", {
                sessionName,
                agentId: agent.id,
                inputKeys: Object.keys(input),
                hookEventName: (input as any).hook_event_name,
              });
              return preCompactHook(input as any, toolUseId ?? null, context as any);
            },
          ],
        },
      ];

      // PreToolUse hook for ExitPlanMode — request approval via WhatsApp reaction.
      // With bypassPermissions the canUseTool callback is NOT called, but hooks still fire.
      // Supports cascading approvals: if agent has no channel, uses _approvalSource from delegating agent.
      const exitPlanHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> =
        async (input) => {
          // Extract plan text from plan file or tool_input
          let planText = "";
          const toolInput = input.tool_input as Record<string, unknown> | undefined;

          try {
            const { readFileSync, readdirSync, statSync } = await import("node:fs");
            const planDir = join(sessionCwd, ".claude", "plans");
            const files = (() => {
              try {
                return readdirSync(planDir)
                  .filter((f: string) => f.endsWith(".md"))
                  .map((f: string) => ({ name: f, mtime: statSync(join(planDir, f)).mtimeMs }))
                  .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
              } catch {
                return [];
              }
            })();
            if (files.length > 0) {
              planText = readFileSync(join(planDir, files[0].name), "utf-8");
            }
          } catch {
            /* fallback below */
          }

          if (!planText && toolInput) {
            if (typeof toolInput.plan === "string") {
              planText = toolInput.plan;
            } else {
              const {
                allowedPrompts: _ap,
                pushToRemote: _ptr,
                remoteSessionId: _rsi,
                remoteSessionTitle: _rst,
                remoteSessionUrl: _rsu,
                ...rest
              } = toolInput;
              planText = Object.keys(rest).length > 0 ? JSON.stringify(rest, null, 2) : "(plano vazio)";
            }
          }
          if (!planText) planText = "(plano vazio)";

          const result = await requestCascadingApproval({
            resolvedSource,
            approvalSource,
            type: "plan",
            sessionName,
            agentId: agent.id,
            text: planText,
          });

          if (result.approved) return {};

          const reason = result.reason ? `Plano rejeitado: ${result.reason}` : "Plano rejeitado pelo usuário.";
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
        };

      // PreToolUse hook for AskUserQuestion — send WhatsApp poll and wait for answer.
      // Supports cascading approvals via _approvalSource.
      const askUserQuestionHook: (
        input: any,
        toolUseId: string | null,
        context: any,
      ) => Promise<Record<string, unknown>> = async (input) => {
        const targetSource = resolvedSource ?? approvalSource;
        if (!targetSource) {
          log.info("AskUserQuestion auto-approved (no source available)", { sessionName });
          return {};
        }

        const isDelegated = !resolvedSource && !!approvalSource;

        const toolInput = input.tool_input as Record<string, unknown> | undefined;
        const questions = toolInput?.questions as
          | Array<{
              question: string;
              header: string;
              options: Array<{ label: string; description: string }>;
              multiSelect: boolean;
            }>
          | undefined;

        if (!questions || questions.length === 0) return {};

        log.info("AskUserQuestion hook: sending polls", { sessionName, questionCount: questions.length, isDelegated });

        nats
          .emit("ravi.approval.request", {
            type: "question",
            sessionName,
            agentId: agent.id,
            delegated: isDelegated,
            channel: targetSource.channel,
            chatId: targetSource.chatId,
            questionCount: questions.length,
            timestamp: Date.now(),
          })
          .catch(() => {});

        const answers: Record<string, string> = {};

        for (const q of questions) {
          const optionLabels = q.options.map((o) => o.label);
          const hasDescriptions = q.options.some((o) => o.description);
          let pollName = isDelegated ? `[${agent.id}] ${q.question}` : q.question;
          if (hasDescriptions) {
            const descLines = q.options.map((o) => `• ${o.label} — ${o.description}`).join("\n");
            pollName += "\n\n" + descLines;
          }
          pollName += "\n(responda a mensagem para outro)";

          const result = await requestPollAnswer(targetSource, pollName, optionLabels, {
            selectableCount: q.multiSelect ? optionLabels.length : 1,
          });

          if ("selectedLabels" in result) {
            answers[q.question] = result.selectedLabels.join(", ");
          } else {
            answers[q.question] = result.freeText;
          }
        }

        nats
          .emit("ravi.approval.response", {
            type: "question",
            sessionName,
            agentId: agent.id,
            approved: true,
            answers,
            timestamp: Date.now(),
          })
          .catch(() => {});

        log.info("AskUserQuestion answers collected", { sessionName, answers, isDelegated });
        return {
          hookSpecificOutput: {
            hookEventName: "PreToolUse" as const,
            updatedInput: { ...toolInput, answers },
          },
        };
      };

      // Spec mode hooks
      const specBlockHook = async (input: any) => {
        if (!isSpecModeActive(sessionName)) return {};

        const toolName = input.tool_name;
        const BLOCKED_IN_SPEC = ["Edit", "Write", "Bash", "NotebookEdit", "Skill", "Task"];

        // Allow spec tools themselves
        if (typeof toolName === "string" && toolName.startsWith("mcp__spec__")) return {};

        if (BLOCKED_IN_SPEC.includes(toolName)) {
          log.info("Spec mode blocked tool", { sessionName, toolName });
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason:
                "Spec mode ativo. Colete informações e complete a spec antes de implementar. Use Read, Glob, Grep, WebFetch para explorar.",
            },
          };
        }
        return {};
      };

      // Supports cascading approvals via _approvalSource.
      const exitSpecHook: (input: any, toolUseId: string | null, context: any) => Promise<Record<string, unknown>> =
        async (input) => {
          const spec = (input.tool_input as Record<string, unknown> | undefined)?.spec as string | undefined;
          if (!spec) return {};

          const result = await requestCascadingApproval({
            resolvedSource,
            approvalSource,
            type: "spec",
            sessionName,
            agentId: agent.id,
            text: spec,
          });

          if (result.approved) {
            const state = getSpecState(sessionName);
            if (state) state.active = false;
            return {};
          }

          const reason = result.reason ? `Spec rejeitada: ${result.reason}` : "Spec rejeitada pelo usuário.";
          return {
            hookSpecificOutput: {
              hookEventName: "PreToolUse",
              permissionDecision: "deny",
              permissionDecisionReason: reason,
            },
          };
        };

      // Append hooks to PreToolUse
      hooks.PreToolUse = [
        ...(hooks.PreToolUse ?? []),
        { hooks: [specBlockHook] },
        { matcher: "mcp__spec__exit_spec_mode", hooks: [exitSpecHook] },
        { matcher: "ExitPlanMode", hooks: [exitPlanHook] },
        { matcher: "AskUserQuestion", hooks: [askUserQuestionHook] },
      ];

      log.info("Hooks registered", {
        sessionName,
        hookEvents: Object.keys(hooks),
      });
    }

    const discoveredPlugins = discoverPlugins();
    const runtimePlugins = runtimeCapabilities.supportsPlugins ? discoveredPlugins : [];
    const abortController = new AbortController();

    // Create the streaming session state before runtime bootstrap so concurrent
    // prompts target this pending session instead of spawning a duplicate.
    const streamingSession: StreamingSession = {
      queryHandle: createPendingRuntimeHandle(runtimeProviderId),
      starting: true,
      abortController,
      pushMessage: null,
      pendingWake: false,
      pendingMessages: [this.createQueuedUserMessage(prompt)],
      currentSource: resolvedSource,
      currentModel: model,
      currentEffort: runtimeResolution.options.effort,
      currentThinking: runtimeResolution.options.thinking,
      currentTaskBarrierTaskId: normalizePromptTaskBarrierTaskId(prompt.taskBarrierTaskId),
      toolRunning: false,
      lastActivity: Date.now(),
      done: false,
      interrupted: false,
      turnActive: false,
      compacting: false,
      onTurnComplete: null,
      currentToolSafety: null,
      pendingAbort: false,
      agentMode: agent.mode,
    };
    this.streamingSessions.set(sessionName, streamingSession);

    try {
      assertRuntimeCompatibility(runtimeProvider, {
        requiresMcpServers: !!agent.specMode,
        requiresRemoteSpawn: !!agent.remote,
        toolAccessMode: getRuntimeToolAccessMode(runtimeCapabilities, agent.id),
      });

      // Create spec mode MCP server for this session (only if agent has specMode enabled)
      const specServer =
        runtimeCapabilities.supportsMcpServers && agent.specMode ? createSpecServer(sessionName, sessionCwd) : null;

      // Create the AsyncGenerator that feeds messages to the SDK
      const messageGenerator = this.createMessageGenerator(sessionName, streamingSession);

      const runId = Math.random().toString(36).slice(2, 8);
      const resumableProviderSessionId = canResumeStoredSession ? storedProviderSessionId : undefined;
      log.info("Starting streaming session", {
        runId,
        sessionName,
        agentId: agent.id,
        provider: runtimeProviderId,
        model,
        effort: runtimeResolution.options.effort ?? null,
        thinking: runtimeResolution.options.thinking ?? null,
        modelSource: runtimeResolution.sources.model,
        providerSessionId: resumableProviderSessionId ?? null,
        resuming: !!resumableProviderSessionId,
      });

      const runtimeContext = createRuntimeContext({
        kind: "agent-runtime",
        agentId: agent.id,
        sessionKey: dbSessionKey,
        sessionName,
        source: resolvedSource
          ? {
              channel: resolvedSource.channel,
              accountId: resolvedSource.accountId,
              chatId: resolvedSource.chatId,
              ...(resolvedSource.threadId ? { threadId: resolvedSource.threadId } : {}),
            }
          : undefined,
        capabilities: snapshotAgentCapabilities(agent.id),
        metadata: {
          runtimeProvider: runtimeProviderId,
          runtimeModel: model,
          ...(runtimeResolution.options.effort ? { runtimeEffort: runtimeResolution.options.effort } : {}),
          ...(runtimeResolution.options.thinking ? { runtimeThinking: runtimeResolution.options.thinking } : {}),
          runtimeModelSource: runtimeResolution.sources.model,
          ...(approvalSource ? { approvalSource } : {}),
        },
      });

      // Build RAVI_* env vars for session context (available in Bash tools)
      const raviEnv: Record<string, string> = {
        RAVI_CONTEXT_KEY: runtimeContext.contextKey,
        RAVI_SESSION_KEY: dbSessionKey,
        RAVI_SESSION_NAME: sessionName,
        RAVI_AGENT_ID: agent.id,
      };
      if (resolvedSource) {
        raviEnv.RAVI_CHANNEL = resolvedSource.channel;
        raviEnv.RAVI_ACCOUNT_ID = resolvedSource.accountId;
        raviEnv.RAVI_CHAT_ID = resolvedSource.chatId;
      } else if (prompt.context?.accountId) {
        // Sentinel inbound: no source but context carries accountId from gateway
        raviEnv.RAVI_ACCOUNT_ID = prompt.context.accountId;
        if (prompt.context.channelId) raviEnv.RAVI_CHANNEL = prompt.context.channelId;
      } else if (agent.mode === "sentinel") {
        // Sentinel heartbeat/cross-send: resolve accountId from instances table
        const accountId = getAccountForAgent(agent.id);
        if (accountId) raviEnv.RAVI_ACCOUNT_ID = accountId;
      }
      if (prompt.context) {
        raviEnv.RAVI_SENDER_ID = prompt.context.senderId;
        if (prompt.context.senderName) raviEnv.RAVI_SENDER_NAME = prompt.context.senderName;
        if (prompt.context.senderPhone) raviEnv.RAVI_SENDER_PHONE = prompt.context.senderPhone;
        if (prompt.context.isGroup) {
          if (prompt.context.groupId) raviEnv.RAVI_GROUP_ID = prompt.context.groupId;
          if (prompt.context.groupName) raviEnv.RAVI_GROUP_NAME = prompt.context.groupName;
        }
      }
      Object.assign(raviEnv, buildTaskRuntimeEnv(sessionName, sessionCwd, prompt.taskBarrierTaskId));

      const toolContext = {
        contextId: runtimeContext.contextId,
        context: runtimeContext,
        sessionKey: dbSessionKey,
        sessionName,
        agentId: agent.id,
        source: resolvedSource,
      };
      const hostServices = createRuntimeHostServices({
        context: runtimeContext,
        agentId: agent.id,
        sessionName,
        resolvedSource,
        approvalSource,
        toolContext,
      });
      const providerBootstrap = await runtimeProvider.prepareSession?.({
        agentId: agent.id,
        cwd: sessionCwd,
        ...(discoveredPlugins.length > 0 ? { plugins: discoveredPlugins } : {}),
        hostServices,
      });
      const baseRuntimeEnv = Object.fromEntries(
        Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
      const runtimeEnv = buildRuntimeEnv(baseRuntimeEnv, raviEnv, providerBootstrap?.env, runtimeCapabilities);

      // canUseTool — auto-approve all tools.
      // Note: with bypassPermissions, canUseTool is NOT called. We use PreToolUse hooks instead.
      const canUseTool = async (_toolName: string, input: Record<string, unknown>) => {
        return { behavior: "allow" as const, updatedInput: input };
      };

      // Note: Spec MCP tools are not affected by REBAC tool permissions.
      // The PreToolUse hook only checks SDK_TOOLS, so MCP tools pass through.

      // Fork: new thread session → copy context from parent session
      let forkFromSdkId: string | undefined;
      if (!resumableProviderSessionId && runtimeCapabilities.supportsSessionFork && dbSessionKey.includes(":thread:")) {
        const parentKey = dbSessionKey.replace(/:thread:.*$/, "");
        const parentSession = getSession(parentKey);
        const parentProviderSessionId =
          parentSession?.runtimeSessionDisplayId ?? parentSession?.providerSessionId ?? parentSession?.sdkSessionId;
        const parentRuntimeProvider = parentSession ? resolveStoredRuntimeProvider(parentSession) : undefined;
        if (parentProviderSessionId && parentRuntimeProvider === runtimeProviderId) {
          forkFromSdkId = parentProviderSessionId;
          log.info("Forking thread session from parent", {
            threadKey: dbSessionKey,
            parentKey,
            parentSdkId: forkFromSdkId,
          });
        }
      }

      // Remote execution: spawn Claude on a remote VM
      // "worker:201" → NATS transport, "201" → SSH fallback
      const remoteSpawn =
        runtimeCapabilities.supportsRemoteSpawn && agent.remote
          ? agent.remote.startsWith("worker:")
            ? createNatsRemoteSpawn(agent.remote.slice("worker:".length))
            : createRemoteSpawn(agent.remote, agent.remoteUser)
          : undefined;
      const resumeProviderSessionId = runtimeCapabilities.supportsSessionResume
        ? (forkFromSdkId ?? resumableProviderSessionId)
        : undefined;

      const runtimeRequest: RuntimeStartRequest = {
        prompt: messageGenerator,
        model,
        ...(runtimeResolution.options.effort ? { effort: runtimeResolution.options.effort } : {}),
        ...(runtimeResolution.options.thinking ? { thinking: runtimeResolution.options.thinking } : {}),
        cwd: sessionCwd,
        ...(resumeProviderSessionId ? { resume: resumeProviderSessionId } : {}),
        ...(canResumeStoredSession
          ? {
              resumeSession: {
                params: storedRuntimeSessionParams,
                displayId: session.runtimeSessionDisplayId ?? storedProviderSessionId,
              },
            }
          : {}),
        ...(forkFromSdkId ? { forkSession: true } : {}),
        abortController,
        permissionOptions,
        canUseTool,
        ...(providerBootstrap?.startRequest ?? {}),
        env: runtimeEnv,
        ...(specServer ? { mcpServers: { spec: specServer } } : {}),
        systemPromptAppend,
        settingSources: agent.settingSources ?? ["project"],
        ...(Object.keys(hooks).length > 0 ? { hooks } : {}),
        ...(runtimePlugins.length > 0 ? { plugins: runtimePlugins } : {}),
        ...(remoteSpawn ? { remoteSpawn } : {}),
      };

      const runtimeSession = runtimeProvider.startSession(runtimeRequest);
      const persistedRuntimeProviderSessionId = canResumeStoredSession ? storedProviderSessionId : undefined;
      updateRuntimeProviderState(session.sessionKey, runtimeProviderId, {
        ...(persistedRuntimeProviderSessionId ? { providerSessionId: persistedRuntimeProviderSessionId } : {}),
        ...(canResumeStoredSession && storedRuntimeSessionParams
          ? { runtimeSessionParams: storedRuntimeSessionParams }
          : {}),
        ...(canResumeStoredSession && (session.runtimeSessionDisplayId ?? storedProviderSessionId)
          ? { runtimeSessionDisplayId: session.runtimeSessionDisplayId ?? storedProviderSessionId }
          : {}),
      });
      session.runtimeProvider = runtimeProviderId;
      if (persistedRuntimeProviderSessionId) {
        session.runtimeSessionParams = storedRuntimeSessionParams;
        session.runtimeSessionDisplayId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
        session.providerSessionId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
        session.sdkSessionId = session.runtimeSessionDisplayId ?? storedProviderSessionId;
      }
      if (prompt.taskBarrierTaskId) {
        const acceptedTask = dbMarkTaskAcceptedForSession(sessionName, prompt.taskBarrierTaskId);
        if (acceptedTask?.event) {
          try {
            await emitTaskEvent(acceptedTask.task, acceptedTask.event);
          } catch (error) {
            log.warn("Failed to emit task bootstrap event", {
              taskId: acceptedTask.task.id,
              sessionName,
              error,
            });
          }
        }
      }
      streamingSession.queryHandle = runtimeSession;
      streamingSession.starting = false;

      // Run the event loop in the background (don't await — it stays alive)
      runWithContext(toolContext, () =>
        this.runEventLoop(
          runId,
          sessionName,
          session,
          agent,
          streamingSession,
          runtimeSession,
          runtimeCapabilities,
          model,
        ),
      ).catch((err) => {
        const isAbort = err instanceof Error && /abort/i.test(err.message);
        if (isAbort) {
          log.info("Streaming session aborted", { sessionName });
        } else {
          log.error("Streaming session failed", { sessionName, error: err });
        }
      });
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      log.error("Failed to start streaming session", {
        sessionName,
        provider: runtimeProviderId,
        error: err,
      });

      streamingSession.done = true;
      streamingSession.starting = false;
      if (!streamingSession.abortController.signal.aborted) {
        streamingSession.abortController.abort();
      }
      this.streamingSessions.delete(sessionName);
      this.drainPendingStarts();

      await safeEmit(`ravi.session.${sessionName}.runtime`, {
        type: "turn.failed",
        provider: runtimeProviderId,
        error: errorMessage,
        recoverable: false,
        ...(resolvedSource ? { _source: resolvedSource } : {}),
      });

      if (resolvedSource && agent.mode !== "sentinel") {
        await nats.emit(`ravi.session.${sessionName}.response`, {
          response: formatUserFacingTurnFailure(errorMessage),
          target: resolvedSource,
          _emitId: Math.random().toString(36).slice(2, 8),
          _instanceId: this.instanceId,
          _pid: process.pid,
          _v: 2,
        });
      }
    }
  }

  /** AsyncGenerator that yields user messages. Stays alive between turns. */
  private async *createMessageGenerator(sessionName: string, session: StreamingSession): AsyncGenerator<UserMessage> {
    // Re-inject stashed messages from a previous abort
    const stashed = this.stashedMessages.get(sessionName);
    if (stashed && stashed.length > 0) {
      log.info("Re-injecting stashed messages", { sessionName, count: stashed.length });
      for (const message of [...stashed].reverse()) {
        session.pendingMessages.unshift({ ...message });
      }
      this.stashedMessages.delete(sessionName);
    }

    while (!session.done) {
      const deliverable = this.getDeliverablePendingMessages(sessionName, session);

      // Wait for messages if queue is empty or still blocked by delivery barriers
      if (deliverable.length === 0) {
        if (session.pendingWake) {
          session.pendingWake = false;
          continue;
        }
        await new Promise<void>((resolve) => {
          session.pushMessage = () => {
            session.pendingWake = false;
            resolve();
          };
        });
        if (session.pendingMessages.length === 0 && session.done) break;
        continue;
      }

      const yieldedIds = new Set(deliverable.map((message) => message.pendingId).filter(Boolean));
      const combined = deliverable.map((m) => m.message.content).join("\n\n");
      log.info("Generator: yielding", {
        sessionName,
        count: deliverable.length,
        queued: session.pendingMessages.length,
      });

      // Arm the turn-complete signal before yielding. AsyncGenerator consumers only
      // resume execution after requesting the next prompt, so wiring this after the
      // yield can miss terminal events and leave the generator stuck between turns.
      const turnCompleted = new Promise<void>((resolve) => {
        session.onTurnComplete = resolve;
      });
      session.turnActive = true;

      yield {
        type: "user" as const,
        message: { role: "user" as const, content: combined },
        session_id: "",
        parent_tool_use_id: null,
      };

      // Wait for result handler to signal turn complete
      await turnCompleted;

      if (session.interrupted) {
        // Turn was interrupted — keep ALL messages (they'll be re-yielded combined)
        log.info("Generator: turn interrupted, keeping queue", {
          sessionName,
          count: session.pendingMessages.length,
        });
        session.interrupted = false;
      } else {
        // Turn completed normally — remove only the messages that were yielded.
        // Lower-priority blocked messages stay parked in the queue.
        session.pendingMessages = session.pendingMessages.filter((message) => !yieldedIds.has(message.pendingId));
        log.info("Generator: turn complete", {
          sessionName,
          cleared: deliverable.length,
          remaining: session.pendingMessages.length,
        });
      }
    }
  }

  /** Process provider events from the streaming runtime session */
  private async runEventLoop(
    runId: string,
    sessionName: string,
    session: SessionEntry,
    agent: AgentConfig,
    streaming: StreamingSession,
    runtimeSession: RuntimeSessionHandle,
    runtimeCapabilities: RuntimeCapabilities,
    model: string,
  ): Promise<void> {
    // Timeout watchdog
    const SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes (longer for streaming)
    const watchdog = setInterval(() => {
      const elapsed = Date.now() - streaming.lastActivity;
      if (elapsed > SESSION_TIMEOUT_MS) {
        log.warn("Streaming session idle timeout", { sessionName, elapsedMs: elapsed });
        streaming.done = true;
        if (streaming.pushMessage) {
          streaming.pushMessage(null as any);
          streaming.pushMessage = null;
        }
        streaming.abortController.abort();
        this.streamingSessions.delete(sessionName);
        clearInterval(watchdog);
      }
    }, 30000);

    let providerRawEventCount = 0;
    let responseText = "";
    const clearActiveToolState = () => {
      streaming.toolRunning = false;
      streaming.currentToolId = undefined;
      streaming.currentToolName = undefined;
      streaming.toolStartTime = undefined;
      streaming.currentToolSafety = null;
    };
    const signalTurnComplete = () => {
      if (streaming.onTurnComplete) {
        streaming.onTurnComplete();
        streaming.onTurnComplete = null;
      }
    };

    const emitLegacyProviderEvent = async (event: Record<string, unknown>) => {
      const legacyEventTopicSuffix = runtimeCapabilities.legacyEventTopicSuffix;
      if (!legacyEventTopicSuffix) {
        return;
      }

      // Include _source on turn-ending events so any gateway daemon can stop typing.
      // In multi-daemon mode the daemon that processes the prompt may differ from
      // the daemon that received the inbound message (which set activeTargets locally).
      const augmented =
        (event.type === "result" || event.type === "silent") && streaming.currentSource
          ? { ...event, _source: streaming.currentSource }
          : event;
      await safeEmit(`ravi.session.${sessionName}.${legacyEventTopicSuffix}`, augmented);
    };

    const emitRuntimeEvent = async (event: Record<string, unknown>) => {
      const augmented =
        (event.type === "turn.complete" ||
          event.type === "turn.failed" ||
          event.type === "turn.interrupted" ||
          event.type === "silent") &&
        streaming.currentSource
          ? { ...event, _source: streaming.currentSource }
          : event;
      await safeEmit(`ravi.session.${sessionName}.runtime`, augmented);
    };

    const emitResponse = async (text: string) => {
      const emitId = Math.random().toString(36).slice(2, 8);
      log.info("Emitting response", { sessionName, emitId, textLen: text.length });
      await nats.emit(`ravi.session.${sessionName}.response`, {
        response: text,
        target: streaming.agentMode === "sentinel" ? undefined : streaming.currentSource,
        _emitId: emitId,
        _instanceId: this.instanceId,
        _pid: process.pid,
        _v: 2,
      });
    };

    const emitChunk = async (text: string, metadata?: RuntimeEventMetadata) => {
      await safeEmit(`ravi.session.${sessionName}.stream`, {
        chunk: text,
        ...(metadata ? { metadata } : {}),
      });
    };

    let chunkEmitTail: Promise<void> = Promise.resolve();
    const queueChunkEmit = (text: string, metadata?: RuntimeEventMetadata) => {
      chunkEmitTail = chunkEmitTail
        .catch(() => {})
        .then(() => emitChunk(text, metadata))
        .catch((error) => {
          log.warn("Failed to emit stream chunk", { sessionName, error });
        });
    };

    try {
      for await (const event of runtimeSession.events) {
        providerRawEventCount++;
        streaming.lastActivity = Date.now();

        const logLevel = event.type === "text.delta" ? "debug" : "info";
        log[logLevel]("Runtime event", {
          runId,
          seq: providerRawEventCount,
          type: event.type,
          sessionName,
        });

        if (event.type === "text.delta") {
          queueChunkEmit(event.text, event.metadata);
          continue;
        }

        await chunkEmitTail;

        if (event.type === "provider.raw" && event.rawEvent) {
          await emitLegacyProviderEvent(event.rawEvent);
        }

        await emitRuntimeEvent(
          event.type === "provider.raw"
            ? { type: "provider.raw", provider: runtimeSession.provider, metadata: event.metadata }
            : { ...event, provider: runtimeSession.provider },
        );

        // Track compaction status — block interrupts while compacting
        if (event.type === "status") {
          const status = event.status;
          const wasCompacting = streaming.compacting;
          streaming.compacting = status === "compacting";
          log.info("Compaction status", { sessionName, compacting: streaming.compacting });

          if (getAnnounceCompaction() && streaming.currentSource && streaming.agentMode !== "sentinel") {
            if (streaming.compacting && !wasCompacting) {
              emitResponse("🧠 Compactando memória... um momento.").catch(() => {});
            } else if (!streaming.compacting && wasCompacting) {
              emitResponse("🧠 Memória compactada. Pronto pra continuar.").catch(() => {});
            }
          }
        }

        if (event.type === "tool.started") {
          streaming.toolRunning = true;
          streaming.currentToolId = event.toolUse.id;
          streaming.currentToolName = event.toolUse.name;
          streaming.toolStartTime = Date.now();
          streaming.currentToolSafety = getToolSafety(
            event.toolUse.name,
            (event.toolUse.input as Record<string, unknown> | undefined) ?? {},
          );

          safeEmit(`ravi.session.${sessionName}.tool`, {
            event: "start",
            toolId: event.toolUse.id,
            toolName: event.toolUse.name,
            safety: streaming.currentToolSafety,
            input: truncateOutput(event.toolUse.input),
            timestamp: new Date().toISOString(),
            sessionName,
            agentId: agent.id,
            metadata: event.metadata,
          }).catch((err) => log.warn("Failed to emit tool start", { error: err }));
          continue;
        }

        // Handle assistant messages
        if (event.type === "assistant.message") {
          let messageText = event.text;
          if (messageText) {
            // Strip @@SILENT@@ from anywhere in the text and trim
            messageText = messageText
              .replace(new RegExp(SILENT_TOKEN.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g"), "")
              .trim();
            log.info("Assistant message", {
              runId,
              interrupted: streaming.interrupted,
              text: messageText.slice(0, 100),
            });

            if (streaming.interrupted) {
              // Turn was interrupted — discard response
              log.info("Discarding interrupted response", { sessionName, textLen: messageText.length });
            } else if (!messageText) {
              // After stripping SILENT_TOKEN, nothing left
              log.info("Silent response (stripped)", { sessionName });
              await emitLegacyProviderEvent({ type: "silent" });
              await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
            } else {
              responseText += messageText;

              const trimmed = messageText.trim().toLowerCase();
              if (trimmed === "prompt is too long") {
                log.warn("Prompt too long — will auto-reset session", { sessionName });
                streaming._promptTooLong = true;
                await emitLegacyProviderEvent({ type: "silent" });
                await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
              } else if (messageText.trim().endsWith(HEARTBEAT_OK)) {
                log.info("Heartbeat OK", { sessionName });
                await emitLegacyProviderEvent({ type: "silent" });
                await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
              } else if (
                trimmed === "no response requested." ||
                trimmed === "no response requested" ||
                trimmed === "no response needed." ||
                trimmed === "no response needed"
              ) {
                log.info("Silent response (no response requested)", { sessionName });
                await emitLegacyProviderEvent({ type: "silent" });
                await emitRuntimeEvent({ type: "silent", provider: runtimeSession.provider });
              } else {
                await emitResponse(messageText);
              }
            }
          }
          continue;
        }

        // Handle tool results
        if (event.type === "tool.completed") {
          const durationMs = streaming.toolStartTime ? Date.now() - streaming.toolStartTime : undefined;

          safeEmit(`ravi.session.${sessionName}.tool`, {
            event: "end",
            toolId: streaming.currentToolId ?? event.toolUseId ?? "unknown",
            toolName: streaming.currentToolName ?? event.toolName ?? "unknown",
            output: truncateOutput(event.content),
            isError: event.isError ?? false,
            durationMs,
            timestamp: new Date().toISOString(),
            sessionName,
            agentId: agent.id,
            metadata: event.metadata,
          }).catch((err) => log.warn("Failed to emit tool end", { error: err }));

          clearActiveToolState();

          // Execute deferred abort now that unsafe tool has completed
          if (streaming.pendingAbort) {
            if (streaming.pendingMessages.length > 0) {
              log.info("Stashing aborted messages (deferred)", {
                sessionName,
                count: streaming.pendingMessages.length,
              });
              this.stashedMessages.set(
                sessionName,
                streaming.pendingMessages.map((message) => ({ ...message })),
              );
            }
            log.info("Executing deferred abort after unsafe tool completed", { sessionName });
            streaming.abortController.abort();
            this.streamingSessions.delete(sessionName);
          }
          continue;
        }

        // Handle result (turn complete — save and wait for next message)
        if (event.type === "turn.complete") {
          const inputTokens = event.usage.inputTokens;
          const outputTokens = event.usage.outputTokens;
          const cacheRead = event.usage.cacheReadTokens ?? 0;
          const cacheCreation = event.usage.cacheCreationTokens ?? 0;

          log.info("Turn complete", {
            runId,
            interrupted: streaming.interrupted,
            total: inputTokens + cacheRead + cacheCreation,
            new: inputTokens,
            cached: cacheRead,
            written: cacheCreation,
            output: outputTokens,
            sessionId: event.session?.displayId ?? event.providerSessionId,
          });

          const runtimeSessionDisplayId = event.session?.displayId ?? event.providerSessionId;
          const runtimeSessionParams = event.session?.params ?? undefined;
          const persistedSessionId =
            runtimeSessionDisplayId ??
            (typeof runtimeSessionParams?.sessionId === "string" ? runtimeSessionParams.sessionId : undefined);

          if (persistedSessionId) {
            updateProviderSession(session.sessionKey, runtimeSession.provider, persistedSessionId, {
              runtimeSessionParams,
              runtimeSessionDisplayId,
            });
            backfillProviderSessionId(sessionName, persistedSessionId);
            session.runtimeSessionParams = runtimeSessionParams;
            session.runtimeSessionDisplayId = runtimeSessionDisplayId ?? persistedSessionId;
            session.providerSessionId = runtimeSessionDisplayId ?? persistedSessionId;
            session.sdkSessionId = runtimeSessionDisplayId ?? persistedSessionId;
            session.runtimeProvider = runtimeSession.provider;
          }
          updateTokens(session.sessionKey, inputTokens, outputTokens);

          // Track cost event
          const executionModel =
            event.execution?.model ?? (runtimeSession.provider === DEFAULT_RUNTIME_PROVIDER_ID ? streaming.currentModel : null);
          const cost = executionModel
            ? calculateCost(executionModel, {
                inputTokens,
                outputTokens,
                cacheRead,
                cacheCreation,
              })
            : null;
          if (cost && executionModel) {
            dbInsertCostEvent({
              sessionKey: session.sessionKey,
              agentId: agent.id,
              model: executionModel,
              inputTokens,
              outputTokens,
              cacheReadTokens: cacheRead,
              cacheCreationTokens: cacheCreation,
              inputCostUsd: cost.inputCost,
              outputCostUsd: cost.outputCost,
              cacheCostUsd: cost.cacheCost,
              totalCostUsd: cost.totalCost,
              createdAt: Date.now(),
            });
          }

          // Auto-reset session when prompt is too long (compact failed)
          if (streaming._promptTooLong) {
            log.warn("Auto-resetting session due to 'Prompt is too long'", { sessionName });
            deleteSession(session.sessionKey);
            streaming._promptTooLong = false;

            // Notify the user that the session was reset (skip for sentinel)
            if (streaming.currentSource && streaming.agentMode !== "sentinel") {
              nats
                .emit("ravi.outbound.deliver", {
                  channel: streaming.currentSource.channel,
                  accountId: streaming.currentSource.accountId,
                  to: streaming.currentSource.chatId,
                  text: "⚠️ Sessão resetada (contexto estourou). Pode mandar de novo.",
                })
                .catch((err) => log.warn("Failed to notify session reset", { error: err }));
            }

            // Abort the streaming session so next message creates a fresh one
            streaming.abortController.abort();
          }

          if (!streaming.interrupted && responseText.trim()) {
            const sdkId = event.providerSessionId;
            saveMessage(sessionName, "assistant", responseText.trim(), sdkId);
          }

          // Reset for next turn
          responseText = "";
          clearActiveToolState();
          streaming.pendingAbort = false;
          streaming.turnActive = false;

          // Signal generator to continue (it will clear or keep queue based on interrupted flag)
          signalTurnComplete();
          continue;
        }

        if (event.type === "turn.interrupted") {
          log.info("Turn interrupted", { runId, sessionName });
          streaming.interrupted = true;
          responseText = "";
          clearActiveToolState();
          streaming.turnActive = false;
          signalTurnComplete();
          continue;
        }

        if (event.type === "turn.failed") {
          const rawEventSummary = summarizeRuntimeFailureRawEvent(event.rawEvent);
          log.warn("Turn failed", {
            runId,
            sessionName,
            recoverable: event.recoverable ?? true,
            error: event.error,
            failureDetails: formatRuntimeFailureDetails(event),
            rawEvent: rawEventSummary,
          });

          responseText = "";
          clearActiveToolState();
          streaming.pendingAbort = false;
          streaming.turnActive = false;

          if (streaming.interrupted && isRecoverableInterruptionFailure(event)) {
            log.info("Suppressing recoverable interrupted turn failure", {
              runId,
              sessionName,
              error: event.error,
            });
            signalTurnComplete();
            continue;
          }

          if (streaming.agentMode !== "sentinel") {
            await emitResponse(formatUserFacingTurnFailure(event.error));
          }

          signalTurnComplete();
        }
      }
    } finally {
      log.info("Streaming session ended", { runId, sessionName });
      clearInterval(watchdog);

      streaming.done = true;
      streaming.starting = false;

      // Unblock generator if it's waiting (between turns or waiting for turn complete)
      if (streaming.pushMessage) {
        streaming.pushMessage(null as any);
        streaming.pushMessage = null;
      }
      if (streaming.onTurnComplete) {
        streaming.onTurnComplete();
        streaming.onTurnComplete = null;
      }

      // Abort subprocess if still alive
      if (!streaming.abortController.signal.aborted) {
        streaming.abortController.abort();
      }

      this.streamingSessions.delete(sessionName);
      this.drainPendingStarts();
    }
  }

  /** Dequeue and start the next pending session if a slot is available */
  private drainPendingStarts(): void {
    if (this.pendingStarts.length > 0 && this.streamingSessions.size < MAX_CONCURRENT_SESSIONS) {
      const next = this.pendingStarts.shift()!;
      log.info("Dequeuing pending session start", {
        sessionName: next.sessionName,
        active: this.streamingSessions.size,
        queued: this.pendingStarts.length,
        max: MAX_CONCURRENT_SESSIONS,
      });
      next.resolve();
    }
  }

  /** Update session metadata (source, context, display name) */
  private updateSessionMetadata(sessionKey: string, prompt: PromptMessage): void {
    if (prompt.source) {
      updateSessionSource(sessionKey, prompt.source);
    }

    if (prompt.context?.senderId) {
      const channelCtx: ChannelContext = {
        channelId: prompt.context.channelId,
        channelName: prompt.context.channelName,
        isGroup: prompt.context.isGroup,
        groupName: prompt.context.groupName,
        groupId: prompt.context.groupId,
        groupMembers: prompt.context.groupMembers,
      };
      updateSessionContext(sessionKey, JSON.stringify(channelCtx));
      if (prompt.context.groupName) {
        updateSessionDisplayName(sessionKey, prompt.context.groupName);
      }
    }
  }
}
