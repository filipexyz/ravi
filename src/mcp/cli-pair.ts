/**
 * The CLI pair `ravi mcp tools` and `ravi mcp call` (spec mcp, CLI Pair): the
 * way Pi (as its dynamic tools `mcp_tools` / `mcp_call`), Codex and Grok (in
 * their shell tool) reach registered MCP servers.
 *
 * This module holds what the two commands decide without the network: which
 * cached tools a turn may see, how `--input` and `--wait` are read, what a
 * dry run may show (argument keys, never values), and how a gateway outcome
 * becomes CLI output (text and structured content; other content by type and
 * size). The call itself runs in the daemon's gateway, which authorizes it
 * again. Nothing here imports the MCP client.
 */

import type { ContextRecord } from "../router/router-db.js";
import { type AuthorizeMcpUseDeps, authorizeMcpUse, type McpDenialCode } from "./authorize.js";
import type { McpGatewayCallResult } from "./gateway.js";
import { mcpCatalogForAttachment } from "./extensions.js";
import { exposedToolName, MCP_TOOL_NAME_PREFIX } from "./names.js";
import { listMcpAttachments } from "./registry-db.js";

/** A tool description in `ravi mcp tools` is cut to this many UTF-8 bytes. */
export const MCP_TOOLS_DESCRIPTION_MAX_BYTES = 1024;
/** One `ravi mcp tools` answer lists at most this many tools for the agent's turn. */
export const MCP_TOOLS_LIST_MAX_TOOLS = 100;
/** One `ravi mcp tools` answer holds at most this many UTF-8 bytes of tool entries (JSON). */
export const MCP_TOOLS_LIST_MAX_BYTES = 96 * 1024;
/** `--query` longer than this is a usage error. */
export const MCP_TOOLS_QUERY_MAX = 200;
/** Default `--wait` of `ravi mcp call`, in seconds. */
export const MCP_CALL_DEFAULT_WAIT_S = 45;
/** Longest `--wait`: below the 120 s the CLI waits for the gateway's answer. */
export const MCP_CALL_MAX_WAIT_S = 110;
/** Longest `--wait` as a runtime dynamic tool, which the host stops after 60 s. */
export const MCP_CALL_TOOL_MAX_WAIT_S = 55;
/** How long a CLI waits for the daemon's answer to `ravi mcp call`. */
export const MCP_CALL_REMOTE_TIMEOUT_MS = 120_000;
/** Largest `--input`, as UTF-8 JSON text. */
export const MCP_CALL_INPUT_MAX_BYTES = 1024 * 1024;
/** A dry run lists at most this many argument keys, each cut to 64 characters. */
export const MCP_CALL_DRY_RUN_MAX_KEYS = 64;

// ============================================================================
// Tools
// ============================================================================

export interface McpListedTool {
  server: string;
  /** The exposed name `mcp__<server>__<tool>`: the name grants use. */
  name: string;
  /** The remote tool name, what `ravi mcp call <server> <tool>` takes. */
  tool: string;
  description: string | null;
  inputSchema: Record<string, unknown>;
}

export interface McpUnavailableServer {
  server: string;
  code: McpDenialCode;
  reason: string;
}

export interface ListMcpToolsForTurnInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  /** One server; every server attached to the agent when omitted. */
  server?: string;
  /** Case-insensitive text matched against the exposed name, tool name and description. */
  query?: string;
}

export interface McpToolsForTurn {
  /** Every tool that matched, before the listing budget. */
  total: number;
  /** The tools within the listing budget, in stable order (server, then exposed name). */
  tools: McpListedTool[];
  /** Tools left out by the listing budget, per server (sorted by server). */
  omitted: Array<{ server: string; count: number }>;
  /** What was left out and how to see it, or null when nothing was. */
  note: string | null;
  /** Attached servers this turn may not list, with the reason (never a secret). */
  unavailable: McpUnavailableServer[];
}

export interface McpToolsBudget {
  maxTools: number;
  maxBytes: number;
}

function compareListed(a: McpListedTool, b: McpListedTool): number {
  if (a.server !== b.server) return a.server < b.server ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/**
 * Keep the listing within the budget of one answer. Servers take turns (in
 * name order, each tool in exposed-name order), so one large server cannot
 * crowd the others out; a tool whose entry does not fit the bytes left is
 * left out and the next one is tried. The cut is deterministic.
 */
export function applyMcpToolsBudget(
  tools: readonly McpListedTool[],
  budget: McpToolsBudget = { maxTools: MCP_TOOLS_LIST_MAX_TOOLS, maxBytes: MCP_TOOLS_LIST_MAX_BYTES },
): { kept: McpListedTool[]; omitted: Array<{ server: string; count: number }> } {
  const queues = new Map<string, McpListedTool[]>();
  for (const tool of [...tools].sort(compareListed)) {
    const queue = queues.get(tool.server) ?? [];
    queue.push(tool);
    queues.set(tool.server, queue);
  }
  const kept: McpListedTool[] = [];
  const omitted = new Map<string, number>();
  let bytes = 0;
  const order = [...queues.keys()].sort();
  for (let round = 0; ; round++) {
    let any = false;
    for (const server of order) {
      const tool = queues.get(server)?.[round];
      if (!tool) continue;
      any = true;
      const size = Buffer.byteLength(JSON.stringify(tool), "utf8");
      if (kept.length < budget.maxTools && bytes + size <= budget.maxBytes) {
        kept.push(tool);
        bytes += size;
      } else {
        omitted.set(server, (omitted.get(server) ?? 0) + 1);
      }
    }
    if (!any) break;
  }
  kept.sort(compareListed);
  return {
    kept,
    omitted: [...omitted.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([server, count]) => ({ server, count })),
  };
}

/** The note on what the budget left out: how many, and how to narrow the listing. */
export function mcpToolsBudgetNote(
  omitted: ReadonlyArray<{ server: string; count: number }>,
  input: { server?: string; query?: string },
): string | null {
  const count = omitted.reduce((sum, item) => sum + item.count, 0);
  if (count === 0) return null;
  const where = omitted.map((item) => `${item.server} (${item.count})`).join(", ");
  const narrow =
    input.server === undefined
      ? "list one server with ravi mcp tools <server>, or narrow with --query <text>"
      : "narrow with --query <text>";
  return `${count} more tool${count === 1 ? "" : "s"} left out by the listing budget (${MCP_TOOLS_LIST_MAX_TOOLS} tools, ${MCP_TOOLS_LIST_MAX_BYTES / 1024} KB): ${where}. To see them, ${narrow}.`;
}

function cutUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  let cut = Buffer.from(text, "utf8").subarray(0, maxBytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function plainJsonObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { type: "object" };
  try {
    const copy = JSON.parse(JSON.stringify(value)) as unknown;
    return copy && typeof copy === "object" && !Array.isArray(copy)
      ? (copy as Record<string, unknown>)
      : { type: "object" };
  } catch {
    // no-cause: a schema that does not survive JSON is shown as the empty object schema.
    return { type: "object" };
  }
}

/**
 * What this turn may call, from the cached catalogs only (no network):
 * `authorizeMcpUse` with surface `list` on each attached server (checks 1 to
 * 6, no denial recorded), then the granted tools, in stable order (server,
 * then exposed name), cut to the listing budget with a note on what was
 * left out. A server that does not pass is reported in `unavailable` with
 * its code.
 */
export function listMcpToolsForTurn(
  input: ListMcpToolsForTurnInput,
  deps: AuthorizeMcpUseDeps = {},
  budget?: McpToolsBudget,
): McpToolsForTurn {
  const servers =
    input.server !== undefined
      ? [input.server]
      : listMcpAttachments({ agentId: input.agentId }).map((attachment) => attachment.server);
  const query = input.query?.trim().toLowerCase() || null;
  const tools: McpListedTool[] = [];
  const unavailable: McpUnavailableServer[] = [];
  for (const name of [...new Set(servers)].sort()) {
    const decision = authorizeMcpUse(
      { context: input.context, agentId: input.agentId, server: name, surface: "list" },
      deps,
    );
    if (!decision.allowed) {
      unavailable.push({ server: name, code: decision.code, reason: decision.reason });
      continue;
    }
    const granted = new Set(decision.tools ?? []);
    for (const tool of mcpCatalogForAttachment(decision.server, decision.attachment)?.tools ?? []) {
      // Recomputed, never read from the stored row: a stored name grants nothing.
      const exposed = exposedToolName(decision.server.name, tool.name);
      if (!exposed.ok || !granted.has(exposed.name)) continue;
      const description = tool.description ? cutUtf8(tool.description, MCP_TOOLS_DESCRIPTION_MAX_BYTES) : null;
      if (
        query &&
        !exposed.name.toLowerCase().includes(query) &&
        !(tool.description ?? "").toLowerCase().includes(query)
      ) {
        continue;
      }
      tools.push({
        server: decision.server.name,
        name: exposed.name,
        tool: tool.name,
        description,
        inputSchema: plainJsonObject(tool.inputSchema),
      });
    }
  }
  const { kept, omitted } = applyMcpToolsBudget(tools, budget);
  return {
    total: tools.length,
    tools: kept,
    omitted,
    note: mcpToolsBudgetNote(omitted, {
      ...(input.server !== undefined ? { server: input.server } : {}),
      ...(query ? { query } : {}),
    }),
    unavailable,
  };
}

// ============================================================================
// Call input
// ============================================================================

/**
 * The remote tool name from what the caller typed: the remote name itself,
 * or its exposed form `mcp__<server>__<tool>` for that same server.
 */
export function remoteMcpToolName(server: string, tool: string): string {
  const prefix = `${MCP_TOOL_NAME_PREFIX}${server}__`;
  return tool.startsWith(prefix) ? tool.slice(prefix.length) : tool;
}

export type ParsedMcpCallInput = { ok: true; value: Record<string, unknown> } | { ok: false; reason: string };

/** `--input`: one JSON object (default `{}`). The reason never quotes the text. */
export function parseMcpCallInput(text: string | undefined): ParsedMcpCallInput {
  if (text === undefined) return { ok: true, value: {} };
  if (typeof text !== "string") return { ok: false, reason: "--input must be a JSON object." };
  if (Buffer.byteLength(text, "utf8") > MCP_CALL_INPUT_MAX_BYTES) {
    return { ok: false, reason: "--input is larger than 1 MB." };
  }
  if (!text.trim()) return { ok: true, value: {} };
  let parsed: unknown;
  let valid = true;
  try {
    parsed = JSON.parse(text);
  } catch {
    // no-cause: the parser's message quotes the input, which may hold a secret value.
    valid = false;
  }
  if (!valid) return { ok: false, reason: "--input is not valid JSON." };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, reason: "--input must be a JSON object of tool arguments." };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

export type ParsedMcpWait = { ok: true; seconds: number; capped: boolean } | { ok: false; reason: string };

/**
 * `--wait <s>`: whole seconds from 1 to 110 (default 45). As a runtime
 * dynamic tool (`asRuntimeTool`) the wait is capped at 55 s, below the 60 s
 * after which the host stops the tool.
 */
export function parseMcpCallWait(value: string | number | undefined, asRuntimeTool: boolean): ParsedMcpWait {
  let seconds = MCP_CALL_DEFAULT_WAIT_S;
  if (value !== undefined) {
    const text = String(value).trim();
    seconds = /^\d{1,4}$/.test(text) ? Number.parseInt(text, 10) : Number.NaN;
    if (!Number.isInteger(seconds) || seconds < 1 || seconds > MCP_CALL_MAX_WAIT_S) {
      return { ok: false, reason: `--wait must be a whole number of seconds from 1 to ${MCP_CALL_MAX_WAIT_S}.` };
    }
  }
  if (asRuntimeTool && seconds > MCP_CALL_TOOL_MAX_WAIT_S) {
    return { ok: true, seconds: MCP_CALL_TOOL_MAX_WAIT_S, capped: true };
  }
  return { ok: true, seconds, capped: false };
}

/** The top-level argument keys a dry run may show: sorted, cut, never a value. */
export function mcpArgumentKeys(args: Record<string, unknown>): { keys: string[]; more: number } {
  const all = Object.keys(args)
    .map((key) => (key.length > 64 ? `${key.slice(0, 64)}…` : key))
    .sort();
  return { keys: all.slice(0, MCP_CALL_DRY_RUN_MAX_KEYS), more: Math.max(0, all.length - MCP_CALL_DRY_RUN_MAX_KEYS) };
}

// ============================================================================
// Outcomes
// ============================================================================

/** How a denial leaves the CLI: the contract code and exit code. */
export function mcpDenialExit(code: McpDenialCode): { code: string; exitCode: 1 | 2 | 3 } {
  switch (code) {
    case "not_registered":
      return { code: "MCP_SERVER_NOT_FOUND", exitCode: 1 };
    case "invalid_request":
      return { code: "MCP_INVALID_REQUEST", exitCode: 2 };
    case "needs_login":
      return { code: "MCP_NEEDS_LOGIN", exitCode: 1 };
    case "error":
      return { code: "MCP_AUTHORIZATION_FAILED", exitCode: 1 };
    default:
      return { code: `MCP_${code.toUpperCase()}`, exitCode: 3 };
  }
}

export type McpCliContent =
  | { type: "text"; text: string }
  | { type: "omitted"; contentType: string; mimeType: string | null; bytes: number };

export interface McpCliCallResult {
  server: string;
  tool: string;
  name: string;
  /** `detached`: the call continues in the background and its result arrives in the session later. */
  outcome: "ok" | "tool_error" | "detached";
  /** `detached`: the call's id (`ravi mcp calls list|cancel`); null otherwise. */
  callId: string | null;
  content: McpCliContent[];
  structuredContent: Record<string, unknown> | null;
  bytes: number;
  truncated: boolean;
  era: "modern" | "legacy";
  waitSeconds: number;
}

function decodedSize(base64: string): number {
  const clean = base64.replace(/\s+/g, "");
  const padding = clean.endsWith("==") ? 2 : clean.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((clean.length * 3) / 4) - padding);
}

/**
 * A successful gateway outcome as the CLI prints it: text and structured
 * content pass; an image (which only Claude shows) is reported by type and
 * size, never its bytes.
 */
export function projectMcpCallResult(
  result: Extract<McpGatewayCallResult, { ok: true }>,
  call: { server: string; tool: string; name: string; waitSeconds: number },
): McpCliCallResult {
  const content: McpCliContent[] = result.content.map((item) =>
    item.type === "text"
      ? { type: "text", text: item.text }
      : { type: "omitted", contentType: "image", mimeType: item.mimeType || null, bytes: decodedSize(item.data) },
  );
  return {
    server: call.server,
    tool: call.tool,
    name: call.name,
    outcome: result.outcome,
    callId: result.outcome === "detached" ? (result.callId ?? null) : null,
    content,
    structuredContent: result.structuredContent ?? null,
    bytes: result.bytes,
    truncated: result.truncated,
    era: result.era,
    waitSeconds: call.waitSeconds,
  };
}

/** How a failed gateway outcome leaves the CLI. */
export function mcpCallFailureExit(result: Extract<McpGatewayCallResult, { ok: false }>): {
  code: string;
  exitCode: 1 | 2 | 3;
} {
  switch (result.outcome) {
    case "denied":
      return mcpDenialExit(result.code);
    case "needs_login":
      return { code: "MCP_NEEDS_LOGIN", exitCode: 1 };
    case "timeout":
      return { code: "MCP_CALL_TIMEOUT", exitCode: 1 };
    case "cancelled":
      return { code: "MCP_CALL_CANCELLED", exitCode: 1 };
    case "file_refused":
      return { code: "MCP_FILE_REFUSED", exitCode: 3 };
    default:
      return { code: "MCP_CALL_FAILED", exitCode: 1 };
  }
}
