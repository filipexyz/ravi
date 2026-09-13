import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
 */
const TITLE = ${JSON.stringify(PI_PERMISSION_UI_TITLE)};
const READY = ${JSON.stringify(PI_PERMISSION_HOOKS_READY_MESSAGE)};

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
    let confirmed = false;
    try {
      confirmed = (await ctx.ui.confirm(TITLE, payload)) === true;
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      return { block: true, reason: "Denied by Ravi tool permission policy." };
    }
    return undefined;
  });

  // Observational afterToolCall equivalent. Authorization happens in tool_call.
  pi.on("tool_result", async () => {});
}
`;

export interface PiToolPermissionHandlers {
  canUseTool?: RuntimeToolPermissionHandler;
  approveRuntimeRequest?: RuntimeApprovalHandler;
}

export interface PiToolPermissionDecision {
  allowed: boolean;
  reason?: string;
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
  const message = firstString(event.message);
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

  return { allowed: true };
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
  return buildPiPermissionUiResponse(request.id, request.method, decision.allowed);
}

export function buildPiPermissionUiResponse(
  id: string,
  method: string | undefined,
  allowed: boolean,
): Record<string, unknown> {
  if (method === "select") {
    return { type: "extension_ui_response", id, value: allowed ? "Allow" : "Block" };
  }
  if (method === "input" || method === "editor") {
    return allowed
      ? { type: "extension_ui_response", id, value: "allow" }
      : { type: "extension_ui_response", id, cancelled: true };
  }
  return { type: "extension_ui_response", id, confirmed: allowed };
}

export function createPiApprovalHandler(hostServices: RuntimeHostServices): RuntimeApprovalHandler {
  return async (request) => authorizePiHostApproval(hostServices, request);
}

export function materializePiPermissionExtensionFile(directory = join(tmpdir(), "ravi-pi-hooks")): string {
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
