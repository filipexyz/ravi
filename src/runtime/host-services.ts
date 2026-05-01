import { runWithContext } from "../cli/context.js";
import { getAllCommandClasses, createSdkTools } from "../cli/tool-definitions.js";
import { extractTools, type ExportedTool, type ToolResult } from "../cli/tools-export.js";
import { inferRaviCommandSkillGate } from "../cli/skill-gates.js";
import {
  checkDangerousPatterns,
  emitBashDeniedAudit,
  evaluateBashPermission,
  parseBashCommand,
  UNCONDITIONAL_BLOCKS,
} from "../bash/index.js";
import { nats } from "../nats.js";
import { authorizeRuntimeContext, requestPollAnswer, type ApprovalTarget } from "../approval/service.js";
import { agentCan, canWithCapabilityContext } from "../permissions/engine.js";
import type { ContextRecord } from "../router/index.js";
import type {
  RuntimeApprovalResult,
  RuntimeCapabilityAuthorizationResult,
  RuntimeCommandAuthorizationRequest,
  RuntimeDynamicToolCallContentItem,
  RuntimeDynamicToolCallRequest,
  RuntimeDynamicToolCallResult,
  RuntimeDynamicToolExecutionOptions,
  RuntimeDynamicToolSpec,
  RuntimeHostServices,
  RuntimeToolAccessMode,
  RuntimeToolUseAuthorizationRequest,
  RuntimeUserInputRequest,
  RuntimeCapabilities,
} from "./types.js";
import { configuredSkillGateForCommand, configuredSkillGateForTool, evaluateSkillGate } from "./skill-gate.js";

const RUNTIME_BUILTIN_EXECUTABLES = new Set(["ravi"]);
let cachedRuntimeDynamicTools: ExportedTool[] | null = null;
let cachedRuntimeDynamicToolSpecs: RuntimeDynamicToolSpec[] | null = null;

export interface RuntimeHostServicesOptions {
  context: ContextRecord;
  agentId: string;
  sessionName: string;
  resolvedSource?: ApprovalTarget;
  approvalSource?: ApprovalTarget;
  toolContext: Record<string, unknown>;
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

export function getRuntimeToolAccessMode(capabilities: RuntimeCapabilities, agentId: string): RuntimeToolAccessMode {
  const accessRequirement = capabilities.tools?.accessRequirement ?? capabilities.toolAccessRequirement;
  if (accessRequirement === "tool_surface") {
    return hasUnrestrictedToolSurface(agentId) ? "unrestricted" : "restricted";
  }

  return hasUnrestrictedToolExecution(agentId) ? "unrestricted" : "restricted";
}

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

export function createRuntimeHostServices(options: RuntimeHostServicesOptions): RuntimeHostServices {
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
  options: Pick<RuntimeHostServicesOptions, "context" | "agentId" | "sessionName" | "toolContext">,
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

  const gate = configuredSkillGateForTool(tool.name) ?? tool.metadata.skillGate;
  const gateDecision = evaluateSkillGate({
    gate,
    context: options.context,
    toolName: tool.name,
  });
  if (!gateDecision.allowed) {
    return {
      success: false,
      reason: gateDecision.reason,
      contentItems: [{ type: "inputText", text: gateDecision.reason ?? `${tool.name} requires a skill.` }],
    };
  }

  const args = normalizeDynamicToolArguments(request.arguments);
  const result = await runWithContext(options.toolContext, () => tool.handler(args));
  return buildRuntimeDynamicToolResult(result);
}

async function authorizeRuntimeDynamicToolCall(
  options: Pick<RuntimeHostServicesOptions, "context" | "agentId" | "sessionName">,
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
  options: Pick<RuntimeHostServicesOptions, "context">,
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
  options: Pick<RuntimeHostServicesOptions, "context" | "agentId" | "sessionName">,
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

  const gate =
    configuredSkillGateForCommand(command, { executables: parsed.executables }) ??
    inferRaviCommandSkillGate(command, { executables: parsed.executables });
  const gateDecision = evaluateSkillGate({
    gate,
    context: options.context,
    toolName: "Bash",
  });
  if (!gateDecision.allowed) {
    return {
      approved: false,
      reason: gateDecision.reason ?? "Command requires a skill before execution.",
    };
  }

  return { approved: true, inherited, updatedInput: request.input };
}

async function authorizeRuntimeToolUse(
  options: Pick<RuntimeHostServicesOptions, "context">,
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
  options: Pick<RuntimeHostServicesOptions, "agentId" | "sessionName" | "resolvedSource" | "approvalSource">,
  request: RuntimeUserInputRequest,
): Promise<RuntimeApprovalResult> {
  const questions = request.questions;
  const targetSource = options.resolvedSource ?? options.approvalSource;
  if (!targetSource) {
    return { approved: false, reason: "Runtime user input requires a target source." };
  }
  if (questions.length === 0) {
    return { approved: false, reason: "Runtime user input request did not include questions." };
  }
  const unsupportedQuestion = questions.find(
    (question) => (question.options?.map((option) => option.label).filter(Boolean) ?? []).length === 0,
  );
  if (unsupportedQuestion) {
    return {
      approved: false,
      reason: `Runtime user input question requires selectable options: ${unsupportedQuestion.id ?? unsupportedQuestion.question}`,
    };
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
