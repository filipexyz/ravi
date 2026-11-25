/**
 * Claude facade servers (spec mcp, Claude Facade).
 *
 * Claude Code reaches registered MCP servers through in-process forwarding
 * servers, one per attachment the turn may list: a v1 `McpServer` with
 * low-level `tools/list` and `tools/call` handlers, registered as
 * `{type:'sdk', name, instance}`. Claude Code names its tools
 * `mcp__<server>__<tool>`, the same name every other runtime is granted.
 *
 * - The set of facades is built per turn from the cached catalogs (no network
 *   at turn start): an attachment is listed when checks 1 to 4 of
 *   `authorizeMcpUse` pass and at least one of its tools is granted.
 * - A facade serves tools only (no resources, no prompts). `tools/list`
 *   filters the cached catalog with `authorizeMcpUse` on the context record of
 *   the current turn. `tools/call` hands the call to the gateway, which runs
 *   `authorizeMcpUse` again on that record before any network call, under an
 *   inline budget of 240 s. While a person answers a server's question
 *   (elicitation), the call holds the session's approval wait lease, so the
 *   tool watchdog waits with it.
 * - A facade is a forwarding server, never a host server: its name goes only
 *   to the tool hook's gateway list, and the names are disjoint from the host
 *   servers' names.
 * - Nothing the server sends steers a decision: titles, annotations and
 *   `_meta` are not stored or passed on, and a result's `_meta` is dropped.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
  ListToolsRequestSchema,
  type ListToolsResult,
} from "@modelcontextprotocol/sdk/types.js";

import { HOST_MCP_SERVER_NAMES } from "../runtime/host-mcp-server-names.js";
import type { RuntimeGatewayMcpServers, RuntimeMcpServerDetail, RuntimeReportedMcpServers } from "../runtime/types.js";
import type { ContextRecord } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { type AuthorizeMcpUseDeps, authorizeMcpUse } from "./authorize.js";
import type { McpGateway, McpGatewayCallResult, McpPersonWait } from "./gateway.js";
import { getMcpGateway, MCP_MAX_CALL_BUDGET_MS } from "./gateway-instance.js";
import { mcpCatalogForAttachment } from "./extensions.js";
import { checkMcpServerName, exposedToolName } from "./names.js";
import { type McpAgentServerRecord, type McpCatalogTool, listMcpAttachments } from "./registry-db.js";

const log = logger.child("mcp:claude-facade");

/** The inline budget of a call from Claude (spec mcp, Claude Facade). */
export const MCP_FACADE_CALL_BUDGET_MS = MCP_MAX_CALL_BUDGET_MS;
/**
 * Claude Code's own per-call limit for a facade server. A little longer than
 * the budget, so the gateway's timeout (an answer the model can read) always
 * comes first.
 */
export const MCP_FACADE_RUNTIME_TIMEOUT_MS = MCP_FACADE_CALL_BUDGET_MS + 30_000;

const FACADE_VERSION = "1.0.0";

/** A facade as Claude Code registers it. */
export interface ClaudeFacadeServerConfig {
  type: "sdk";
  name: string;
  instance: McpServer;
  timeout: number;
}

export interface BuildGatewayMcpServersOptions {
  agentId: string;
  /** The context record of the current turn; read on every list and call. */
  getContext: () => ContextRecord | null | undefined;
  /** The daemon's gateway (default `getMcpGateway`). */
  getGateway?: () => Pick<McpGateway, "call"> | null;
  /** Overrides for `authorizeMcpUse` (tests). */
  authorize?: AuthorizeMcpUseDeps;
  /** The agent's attachments (default: the registry). */
  listAttachments?: (agentId: string) => McpAgentServerRecord[];
  /**
   * The session's approval wait lease, held while a person answers a
   * server's question during a call (read at call time).
   */
  getApprovalWait?: () => McpPersonWait | null | undefined;
}

export interface BuiltGatewayMcpServers {
  servers: Record<string, ClaudeFacadeServerConfig>;
  detail: RuntimeMcpServerDetail[];
}

type FacadeTool = ListToolsResult["tools"][number];

/**
 * The tool entry Claude Code receives for one catalog tool: the remote name,
 * description and input schema as stored. Claude Code rejects a whole tool
 * list whose input schema is not an object schema, so a tool whose schema
 * cannot be one is left out (and logged); a schema without `type` is an
 * object schema.
 */
export function facadeToolEntry(tool: McpCatalogTool): FacadeTool | null {
  const schema = tool.inputSchema ?? { type: "object" };
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  if (schema.type !== undefined && schema.type !== "object") return null;
  const properties = schema.properties;
  if (properties !== undefined && (!properties || typeof properties !== "object" || Array.isArray(properties))) {
    return null;
  }
  const required = schema.required;
  if (required !== undefined && !(Array.isArray(required) && required.every((item) => typeof item === "string"))) {
    return null;
  }
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    inputSchema: { ...schema, type: "object" } as FacadeTool["inputSchema"],
  };
}

/**
 * The tools a turn may list on one server: `authorizeMcpUse` (surface `list`,
 * which records no denial) on the cached catalog, then the schema check.
 */
function listFacadeTools(
  server: string,
  agentId: string,
  context: ContextRecord | null | undefined,
  deps: AuthorizeMcpUseDeps | undefined,
): { tools: FacadeTool[]; decision: ReturnType<typeof authorizeMcpUse> } {
  const decision = authorizeMcpUse({ context, agentId, server, surface: "list" }, deps);
  if (!decision.allowed) return { tools: [], decision };
  const granted = new Set(decision.tools ?? []);
  const tools: FacadeTool[] = [];
  for (const tool of mcpCatalogForAttachment(decision.server, decision.attachment)?.tools ?? []) {
    // Recomputed, never read from the stored row: a stored name grants nothing.
    const exposed = exposedToolName(decision.server.name, tool.name);
    if (!exposed.ok || !granted.has(exposed.name)) continue;
    const entry = facadeToolEntry(tool);
    if (!entry) {
      log.warn("MCP tool left out of the Claude facade: its input schema is not an object schema", {
        server: decision.server.name,
        tool: tool.name,
      });
      continue;
    }
    tools.push(entry);
  }
  return { tools, decision };
}

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** The gateway's outcome as Claude Code reads it. Upstream `_meta` never reaches it. */
export function facadeCallResult(result: McpGatewayCallResult): CallToolResult {
  if (!result.ok) return errorResult(result.reason);
  const content: CallToolResult["content"] = result.content.map((item) =>
    item.type === "text"
      ? { type: "text" as const, text: item.text }
      : { type: "image" as const, data: item.data, mimeType: item.mimeType },
  );
  if (result.structuredContent && !content.some((item) => item.type === "text")) {
    // Claude reads text; a result that only has structured content is passed as its JSON too.
    content.push({ type: "text", text: JSON.stringify(result.structuredContent) });
  }
  return {
    content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    ...(result.outcome === "tool_error" ? { isError: true } : {}),
  };
}

function createFacadeServer(server: string, options: BuildGatewayMcpServersOptions): McpServer {
  const facade = new McpServer({ name: server, version: FACADE_VERSION }, { capabilities: { tools: {} } });
  const getGateway = options.getGateway ?? getMcpGateway;

  facade.server.setRequestHandler(ListToolsRequestSchema, async () => {
    try {
      return { tools: listFacadeTools(server, options.agentId, options.getContext(), options.authorize).tools };
    } catch (error) {
      // no-cause: a listing that fails shows no tool; the error text may carry context.
      log.warn("MCP facade listing failed; listing no tools", {
        server,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return { tools: [] };
    }
  });

  facade.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try {
      const gateway = getGateway();
      if (!gateway) {
        return errorResult(
          `MCP server ${server} cannot be reached: the Ravi MCP gateway is not running in this process.`,
        );
      }
      const tool = request.params.name;
      const args = request.params.arguments ?? {};
      const approvalWait = options.getApprovalWait?.() ?? undefined;
      const result = await gateway.call(
        { context: options.getContext(), agentId: options.agentId, ...(approvalWait ? { approvalWait } : {}) },
        {
          server,
          tool,
          arguments: args,
          surface: "claude",
          budgetMs: MCP_FACADE_CALL_BUDGET_MS,
          signal: extra.signal,
          // A task result, or a call past the budget, continues in the background; its result arrives
          // in the session as a new message (spec mcp, Background Calls And Tasks).
          detach: true,
        },
      );
      return facadeCallResult(result);
    } catch (error) {
      // no-cause: the gateway never throws; anything else fails closed with a fixed text.
      log.error("MCP facade call failed closed", {
        server,
        errorType: error instanceof Error ? error.name : typeof error,
      });
      return errorResult(`The call to MCP server ${server} failed inside Ravi, so it was not completed.`);
    }
  });

  return facade;
}

/**
 * The facades of one turn: one per attachment the turn may list, keyed by
 * the registered server name. Host server names are never built.
 */
export function buildGatewayMcpServers(options: BuildGatewayMcpServersOptions): BuiltGatewayMcpServers {
  const servers: Record<string, ClaudeFacadeServerConfig> = {};
  const detail: RuntimeMcpServerDetail[] = [];
  const context = options.getContext();
  const attachments = (options.listAttachments ?? ((agentId) => listMcpAttachments({ agentId })))(options.agentId);
  for (const name of [...new Set(attachments.map((attachment) => attachment.server))].sort()) {
    // The registry refuses these names; a row that holds one anyway is never built.
    if (!checkMcpServerName(name).ok || HOST_MCP_SERVER_NAMES.includes(name)) {
      log.warn("MCP facade skipped: the server name is not a valid registered name", { server: name.slice(0, 64) });
      continue;
    }
    const { tools, decision } = listFacadeTools(name, options.agentId, context, options.authorize);
    if (!decision.allowed || tools.length === 0) continue;
    servers[name] = {
      type: "sdk",
      name,
      instance: createFacadeServer(name, options),
      timeout: MCP_FACADE_RUNTIME_TIMEOUT_MS,
    };
    detail.push({
      name,
      kind: "gateway",
      transport: decision.server.transport,
      era: decision.server.era ?? null,
      toolCount: tools.length,
      status: decision.server.status,
    });
  }
  return { servers, detail };
}

export interface ClaudeGatewayFacadesOptions extends BuildGatewayMcpServersOptions {
  /** The session's host server names; a facade never takes one. */
  hostMcpServers: readonly string[];
  /** Called with what Claude Code reported loading. */
  onRuntimeReported?: (report: RuntimeReportedMcpServers) => void;
  /** Called with the facades a query left out because a host server holds their names. */
  onNameOverlap?: (names: string[]) => void;
}

/**
 * The session's holder of its facades. The host calls `prepareTurn` before it
 * hands each turn to Claude; the provider registers `current()` on that
 * turn's query, and the tool hook reads `names()` on every call. A build
 * that fails leaves the turn with no facade (fail closed).
 */
export function createClaudeGatewayFacades(options: ClaudeGatewayFacadesOptions): RuntimeGatewayMcpServers {
  let current: Record<string, ClaudeFacadeServerConfig> = {};
  let names: readonly string[] = Object.freeze([]);
  return {
    prepareTurn() {
      let built: BuiltGatewayMcpServers;
      try {
        built = buildGatewayMcpServers(options);
      } catch (error) {
        // no-cause: the turn runs without facades; the error text may carry context.
        log.error("MCP facades could not be built; the turn has none", {
          agentId: options.agentId,
          errorType: error instanceof Error ? error.name : typeof error,
        });
        built = { servers: {}, detail: [] };
      }
      for (const host of options.hostMcpServers) {
        if (built.servers[host]) {
          log.error("MCP facade dropped: its name is a host server's", { server: host });
          delete built.servers[host];
          built.detail = built.detail.filter((entry) => entry.name !== host);
        }
      }
      current = built.servers;
      names = Object.freeze(Object.keys(built.servers));
      return built.detail;
    },
    current: () => ({ ...current }) as unknown as Record<string, Record<string, unknown>>,
    names: () => names,
    reportRuntimeServers(report) {
      options.onRuntimeReported?.(report);
    },
    reportNameOverlap(overlap) {
      log.warn("MCP facades left out of a turn: a host server holds their names", { servers: overlap });
      options.onNameOverlap?.(overlap);
    },
  };
}
