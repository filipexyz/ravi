import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextCapability } from "../router/router-db.js";
import { getRaviStateDir } from "../utils/paths.js";
import { isSkillAuthorizedForAgent } from "./skill-authorization.js";
import { extractRequestedSkillFromToolCall, isSkillNameAuthorizedOnAllowlist } from "./skill-visibility.js";
import type {
  RuntimeApprovalHandler,
  RuntimeApprovalQuestion,
  RuntimeApprovalRequest,
  RuntimeApprovalResult,
  RuntimeHostServices,
  RuntimeToolPermissionHandler,
} from "./types.js";

export const PI_PERMISSION_UI_TITLE = "ravi.permission.request";
export const PI_PERMISSION_EXTENSION_FILENAME = "ravi-permission-extension.js";
export const PI_PERMISSION_HOOKS_READY_MESSAGE = "ravi.permission.hooks.ready";
export const PI_PERMISSION_BRIDGE_UNAVAILABLE_MESSAGE =
  "Pi permission extension did not confirm ravi-host hooks are live. Refusing to run an ungoverned Pi session.";
export const DEFAULT_PI_PERMISSION_HOOKS_READY_TIMEOUT_MS = 5_000;
/** Last-resort fallback only. Prefer the host/capability/bash/skill/bridge sub-reason. */
export const PI_PERMISSION_OPAQUE_DENY_REASON = "Denied by Ravi tool permission policy.";
export const PI_PERMISSION_DECISION_VERSION = 1;
export const PI_PERMISSION_ALLOW_TOKEN = "allow";
export const PI_PERMISSION_MISSING_DECISION_REASON = "Pi permission UI returned no host decision.";
export const PI_PERMISSION_UNREADABLE_DECISION_REASON = "Pi permission UI returned an unreadable host decision.";
export const PI_PERMISSION_UI_FAILED_REASON = "Pi permission UI request failed.";

export class PiPermissionBridgeError extends Error {
  readonly failureKind = "transport" as const;

  constructor(message = PI_PERMISSION_BRIDGE_UNAVAILABLE_MESSAGE) {
    super(message);
    this.name = "PiPermissionBridgeError";
  }
}

export const PI_RAVI_PERMISSION_EXTENSION_SOURCE = `/**
 * Ravi-owned Pi permission bridge.
 *
 * Pi RPC events are observational. This extension registers the in-process
 * tool_call gate (Pi's beforeToolCall equivalent) and asks the Ravi host
 * over the RPC extension UI protocol before any built-in tool executes.
 *
 * Pi's confirm() only returns boolean, so a deny would collapse to a fixed
 * string. input() returns the host decision value and keeps the sub-reason.
 * Overlapping tool_call hooks are serialized so a single-outstanding-dialog
 * UI cannot cancel a sibling as an unexplained deny.
 */
const TITLE = ${JSON.stringify(PI_PERMISSION_UI_TITLE)};
const READY = ${JSON.stringify(PI_PERMISSION_HOOKS_READY_MESSAGE)};
const OPAQUE = ${JSON.stringify(PI_PERMISSION_OPAQUE_DENY_REASON)};
const ALLOW = ${JSON.stringify(PI_PERMISSION_ALLOW_TOKEN)};
const MISSING = ${JSON.stringify(PI_PERMISSION_MISSING_DECISION_REASON)};
const UNREADABLE = ${JSON.stringify(PI_PERMISSION_UNREADABLE_DECISION_REASON)};
const FAILED = ${JSON.stringify(PI_PERMISSION_UI_FAILED_REASON)};

function parseDecision(value) {
  if (value === true || value === ALLOW) return { allowed: true };
  if (value === false || value == null || value === "") {
    return { allowed: false, reason: MISSING };
  }
  if (typeof value !== "string") {
    return { allowed: false, reason: UNREADABLE };
  }
  const trimmed = value.trim();
  if (trimmed === ALLOW) return { allowed: true };
  try {
    const parsed = JSON.parse(trimmed);
    if (parsed && typeof parsed === "object" && typeof parsed.allowed === "boolean") {
      if (parsed.allowed) return { allowed: true };
      const reason = typeof parsed.reason === "string" && parsed.reason.trim() ? parsed.reason.trim() : OPAQUE;
      return { allowed: false, reason };
    }
  } catch {
    // Fall through to deny: / raw-string handling.
  }
  if (trimmed.startsWith("deny:")) {
    return { allowed: false, reason: trimmed.slice(5).trim() || OPAQUE };
  }
  return { allowed: false, reason: trimmed };
}

let permissionGate = Promise.resolve();

function withPermissionGate(work) {
  const previous = permissionGate;
  let release = () => {};
  permissionGate = new Promise((resolve) => {
    release = resolve;
  });
  return previous.then(work).finally(release);
}

export default function (pi) {
  pi.on("session_start", (_event, ctx) => {
    if (!ctx.ui?.notify) {
      throw new Error("Ravi permission bridge UI is unavailable");
    }
    ctx.ui.notify(READY, "info");
  });

  pi.on("tool_call", async (event, ctx) => {
    const payload = JSON.stringify({
      version: 1,
      toolName: event.toolName,
      toolCallId: event.toolCallId,
      input: event.input ?? {},
    });
    return withPermissionGate(async () => {
      let decision;
      try {
        if (!ctx.ui?.input) {
          throw new Error("Pi permission bridge UI input is unavailable");
        }
        decision = parseDecision(await ctx.ui.input(TITLE, payload));
      } catch (error) {
        decision = {
          allowed: false,
          reason: error instanceof Error && error.message ? error.message : FAILED,
        };
      }
      if (!decision.allowed) {
        return { block: true, reason: decision.reason || OPAQUE };
      }
      return undefined;
    });
  });

  // Observational afterToolCall equivalent. Authorization happens in tool_call.
  pi.on("tool_result", async () => {});
}
`;

export interface PiToolPermissionHandlers {
  canUseTool?: RuntimeToolPermissionHandler;
  approveRuntimeRequest?: RuntimeApprovalHandler;
  /**
   * Canonical allowlist already applied to the Pi catalog. When present and
   * non-empty, skill invocation is gated against this list (hard deny).
   * Absent/empty keeps Invariant F grandfather behavior.
   */
  allowedSkills?: readonly string[];
  /** Executor agent — used to authorize official gated skills from capabilities. */
  agentId?: string;
  capabilities?: readonly ContextCapability[];
}

export interface PiToolPermissionDecision {
  allowed: boolean;
  reason?: string;
}

export function formatPiPermissionUiDecisionValue(decision: PiToolPermissionDecision): string {
  if (decision.allowed) {
    return JSON.stringify({ v: PI_PERMISSION_DECISION_VERSION, allowed: true });
  }
  return JSON.stringify({
    v: PI_PERMISSION_DECISION_VERSION,
    allowed: false,
    reason: decision.reason?.trim() || PI_PERMISSION_OPAQUE_DENY_REASON,
  });
}

export function parsePiPermissionUiDecisionValue(value: unknown): PiToolPermissionDecision {
  if (value === true || value === PI_PERMISSION_ALLOW_TOKEN) {
    return { allowed: true };
  }
  if (value === false || value == null || value === "") {
    return { allowed: false, reason: PI_PERMISSION_MISSING_DECISION_REASON };
  }
  if (typeof value !== "string") {
    return { allowed: false, reason: PI_PERMISSION_UNREADABLE_DECISION_REASON };
  }
  const trimmed = value.trim();
  if (trimmed === PI_PERMISSION_ALLOW_TOKEN) {
    return { allowed: true };
  }
  const parsed = parseJsonRecord(trimmed);
  if (parsed && typeof parsed.allowed === "boolean") {
    if (parsed.allowed) {
      return { allowed: true };
    }
    return {
      allowed: false,
      reason: firstString(parsed.reason) ?? PI_PERMISSION_OPAQUE_DENY_REASON,
    };
  }
  if (trimmed.startsWith("deny:")) {
    return { allowed: false, reason: trimmed.slice("deny:".length).trim() || PI_PERMISSION_OPAQUE_DENY_REASON };
  }
  return { allowed: false, reason: trimmed };
}

export type PiExtensionUiKind = "permission" | "dialog" | "fire-and-forget" | "unknown";

export interface PiExtensionUiRequest {
  kind: PiExtensionUiKind;
  id?: string;
  method?: string;
  title?: string;
  message?: string;
  toolName?: string;
  toolInput?: Record<string, unknown>;
  rawRequest: Record<string, unknown>;
}

const PI_DIALOG_UI_METHODS = new Set(["confirm", "select", "input", "editor"]);
const PI_FIRE_AND_FORGET_UI_METHODS = new Set([
  "notify",
  "setstatus",
  "setwidget",
  "settitle",
  "set_editor_text",
  "seteditortext",
]);

export function mapPiToolNameToRavi(name?: string): string {
  const raw = name?.trim();
  const normalized = raw?.toLowerCase().replace(/[\s_-]+/g, "") ?? "";
  if (!normalized) {
    return "tool";
  }
  if (
    normalized === "bash" ||
    normalized === "shell" ||
    normalized === "execute" ||
    normalized === "terminal" ||
    normalized.includes("runterminal")
  ) {
    return "Bash";
  }
  if (normalized === "read" || normalized === "listdir" || normalized === "ls") {
    return "Read";
  }
  if (normalized === "write") {
    return "Write";
  }
  if (normalized === "edit" || normalized.includes("searchreplace") || normalized.includes("strreplace")) {
    return "Edit";
  }
  if (normalized === "grep" || normalized.includes("searchcontent")) {
    return "Grep";
  }
  if (normalized === "glob" || normalized === "find") {
    return "Glob";
  }
  if (normalized.includes("webfetch") || normalized.includes("webget")) {
    return "WebFetch";
  }
  if (normalized.includes("websearch") || normalized.includes("webquery")) {
    return "WebSearch";
  }
  if (normalized === "skill" || normalized === "skillshow" || normalized.includes("skillshow")) {
    return "Skill";
  }
  return raw || "tool";
}

export function isPiBashTool(name?: string): boolean {
  return mapPiToolNameToRavi(name) === "Bash";
}

export function createPiPermissionHooksReadyEvent(id = "ravi-hooks-ready"): Record<string, unknown> {
  return {
    type: "extension_ui_request",
    id,
    method: "notify",
    message: PI_PERMISSION_HOOKS_READY_MESSAGE,
    notifyType: "info",
  };
}

export function isPiPermissionHooksReadyEvent(event: Record<string, unknown>): boolean {
  if (firstString(event.type) !== "extension_ui_request") {
    return false;
  }
  const request = parsePiPermissionUiRequest(event);
  return (
    request.kind === "fire-and-forget" &&
    request.method === "notify" &&
    request.message === PI_PERMISSION_HOOKS_READY_MESSAGE
  );
}

export function isPiPermissionBridgeError(error: unknown): error is PiPermissionBridgeError {
  return error instanceof PiPermissionBridgeError;
}

export function parsePiPermissionUiRequest(event: Record<string, unknown>): PiExtensionUiRequest {
  const method = firstString(event.method)?.toLowerCase();
  const title = firstString(event.title);
  const message = firstString(event.message, event.placeholder, event.prefill);
  const id = firstString(event.id);
  const payload = extractPiPermissionPayload(title, message, event);

  if (payload) {
    return {
      kind: "permission",
      id,
      method,
      title,
      message,
      toolName: firstString(payload.toolName, payload.tool_name, payload.name) ?? "tool",
      toolInput: asRecord(payload.input) ?? asRecord(payload.args) ?? asRecord(payload.rawInput) ?? {},
      rawRequest: event,
    };
  }

  if (method && PI_FIRE_AND_FORGET_UI_METHODS.has(method)) {
    return { kind: "fire-and-forget", id, method, title, message, rawRequest: event };
  }
  if (method && PI_DIALOG_UI_METHODS.has(method)) {
    return { kind: "dialog", id, method, title, message, rawRequest: event };
  }
  return { kind: "unknown", id, method, title, message, rawRequest: event };
}

export async function authorizePiToolCall(
  toolName: string,
  input: Record<string, unknown>,
  handlers: PiToolPermissionHandlers,
  rawRequest: Record<string, unknown> = {},
): Promise<PiToolPermissionDecision> {
  const mapped = mapPiToolNameToRavi(toolName);
  if (!handlers.canUseTool) {
    return { allowed: false, reason: "Pi tool permission handler is unavailable." };
  }

  let toolResult: Awaited<ReturnType<RuntimeToolPermissionHandler>>;
  try {
    toolResult = await handlers.canUseTool(mapped, input);
  } catch (error) {
    return {
      allowed: false,
      reason: error instanceof Error ? error.message : `Pi tool authorization threw for ${mapped}.`,
    };
  }
  if (toolResult.behavior !== "allow") {
    return { allowed: false, reason: toolResult.reason ?? `${mapped} permission denied.` };
  }

  const command = firstString(input.command, input.cmd);
  if (mapped === "Bash" || command) {
    if (!command) {
      return { allowed: false, reason: "Pi bash permission request did not include a command." };
    }
    if (!handlers.approveRuntimeRequest) {
      return { allowed: false, reason: "Pi command execution authorizer is unavailable." };
    }
    try {
      const commandResult = await handlers.approveRuntimeRequest({
        kind: "command_execution",
        method: "pi.extension_ui_request",
        toolName: "Bash",
        input: { ...input, command },
        rawRequest,
      });
      if (!commandResult.approved) {
        return { allowed: false, reason: commandResult.reason ?? "Command denied by Ravi policy." };
      }
    } catch (error) {
      return {
        allowed: false,
        reason: error instanceof Error ? error.message : "Pi command authorization threw.",
      };
    }
  }

  const requestedSkill = extractRequestedSkillFromToolCall(mapped, input);
  if (requestedSkill && !isPiSkillAuthorized(requestedSkill, handlers)) {
    return {
      allowed: false,
      reason: `SKILL_NOT_AUTHORIZED: Skill not authorized for agent: ${requestedSkill}`,
    };
  }

  return { allowed: true };
}

function isPiSkillAuthorized(skillName: string, handlers: PiToolPermissionHandlers): boolean {
  if (!handlers.allowedSkills || handlers.allowedSkills.length === 0) {
    return true;
  }
  if (isSkillNameAuthorizedOnAllowlist(skillName, handlers.allowedSkills)) {
    return true;
  }
  if (!handlers.agentId) {
    return false;
  }
  return isSkillAuthorizedForAgent(handlers.agentId, skillName, {
    capabilities: handlers.capabilities,
  });
}

export async function resolvePiExtensionUiResponse(
  event: Record<string, unknown>,
  handlers: PiToolPermissionHandlers,
): Promise<Record<string, unknown> | null> {
  const request = parsePiPermissionUiRequest(event);
  if (request.kind === "fire-and-forget") {
    return null;
  }
  if (!request.id) {
    return null;
  }
  if (request.kind !== "permission") {
    return { type: "extension_ui_response", id: request.id, cancelled: true };
  }

  const decision = await authorizePiToolCall(request.toolName ?? "tool", request.toolInput ?? {}, handlers, event);
  return buildPiPermissionUiResponse(request.id, request.method, decision);
}

export function buildPiPermissionUiResponse(
  id: string,
  method: string | undefined,
  decision: boolean | PiToolPermissionDecision,
): Record<string, unknown> {
  const normalized: PiToolPermissionDecision = typeof decision === "boolean" ? { allowed: decision } : decision;
  const value = formatPiPermissionUiDecisionValue(normalized);
  if (method === "select") {
    return { type: "extension_ui_response", id, value: normalized.allowed ? "Allow" : value };
  }
  if (method === "confirm") {
    // Legacy confirm() can only return boolean. Keep confirmed for old
    // extensions and still attach value so a newer extension/parser can read
    // the host sub-reason if the response object is forwarded.
    return { type: "extension_ui_response", id, confirmed: normalized.allowed === true, value };
  }
  return { type: "extension_ui_response", id, value };
}

export function createPiApprovalHandler(hostServices: RuntimeHostServices): RuntimeApprovalHandler {
  return async (request) => authorizePiHostApproval(hostServices, request);
}

/** Durable hook dir. `/tmp/ravi-pi-hooks` is cleaned by tmpwatch and breaks respawn. */
export function resolvePiPermissionExtensionDirectory(env: NodeJS.ProcessEnv = process.env): string {
  return join(getRaviStateDir(env), "pi-hooks");
}

export function materializePiPermissionExtensionFile(directory = resolvePiPermissionExtensionDirectory()): string {
  mkdirSync(directory, { recursive: true });
  const path = join(directory, PI_PERMISSION_EXTENSION_FILENAME);
  writeFileSync(path, PI_RAVI_PERMISSION_EXTENSION_SOURCE, "utf8");
  return path;
}

async function authorizePiHostApproval(
  hostServices: RuntimeHostServices,
  request: RuntimeApprovalRequest,
): Promise<RuntimeApprovalResult> {
  switch (request.kind) {
    case "command_execution": {
      const command = firstString(request.input?.command, request.input?.cmd);
      if (!command) {
        return { approved: false, reason: "Pi command approval request did not include a command." };
      }
      return hostServices.authorizeCommandExecution({
        command,
        input: request.input,
        eventData: buildPiApprovalEventData(request),
      });
    }
    case "file_change":
    case "permission":
      return hostServices.authorizeToolUse({
        toolName: request.toolName ?? (request.kind === "file_change" ? "Edit" : "tool"),
        input: request.input,
        eventData: buildPiApprovalEventData(request),
      });
    case "user_input":
      return hostServices.requestUserInput({
        questions: Array.isArray(request.input?.questions)
          ? (request.input.questions as RuntimeApprovalQuestion[])
          : [],
        eventData: buildPiApprovalEventData(request),
      });
  }
}

function buildPiApprovalEventData(request: RuntimeApprovalRequest): Record<string, unknown> {
  return {
    runtimeApproval: {
      provider: "pi",
      kind: request.kind,
      method: request.method,
      toolName: request.toolName,
      input: request.input,
    },
  };
}

function extractPiPermissionPayload(
  title: string | undefined,
  message: string | undefined,
  event: Record<string, unknown>,
): Record<string, unknown> | null {
  if (title === PI_PERMISSION_UI_TITLE) {
    return parseJsonRecord(message) ?? asRecord(event.payload) ?? { toolName: "tool", input: {} };
  }
  if (title?.startsWith(`${PI_PERMISSION_UI_TITLE}:`)) {
    return parseJsonRecord(title.slice(PI_PERMISSION_UI_TITLE.length + 1));
  }
  const titled = parseJsonRecord(title);
  if (titled && firstString(titled.type, titled.title) === PI_PERMISSION_UI_TITLE) {
    return titled;
  }
  return null;
}

function parseJsonRecord(value: string | undefined): Record<string, unknown> | null {
  if (!value) {
    return null;
  }
  try {
    return asRecord(JSON.parse(value));
  } catch {
    return null;
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}
