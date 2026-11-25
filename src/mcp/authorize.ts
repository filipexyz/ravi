/**
 * The one authorization function every MCP surface passes (spec mcp,
 * Authorization): list, call, late task input, elicitation, skill read and
 * upload. Checks run in a fixed order and the first failure decides:
 *
 *   1. no context record                         no_turn
 *   2. the row exists and is enabled             not_registered | disabled
 *   3. an attachment for the agent exists        not_attached
 *   4. audience (operator = the operator's own   audience | audience_legacy
 *      turn); a credentialed legacy row is
 *      operator-only whatever its audience says
 *   5. tool surfaces: use tool:mcp__<s>__<t>     capability
 *   6. status needs_login                        needs_login
 *
 * Any exception inside becomes a denial (code `error`). Denials are recorded
 * through the permission denial ledger with `detail.mcpServer.source =
 * "gateway"`, except the `list` surface, which filters what a turn sees and
 * is not an attempt to use anything.
 */

import { canUseToolInContext } from "../bash/hook.js";
import { isOperatorOwnTurn } from "../library/turn.js";
import { buildAuditContextProvenance } from "../permissions/audit-provenance.js";
import { recordAndEmitPermissionDenial } from "../permissions/denials.js";
import type { ContextRecord } from "../router/router-db.js";
import { logger } from "../utils/logger.js";
import { mcpCatalogForAttachment } from "./extensions.js";
import { exposedToolName } from "./names.js";
import { getMcpAttachment, getMcpServer, type McpAgentServerRecord, type McpServerRecord } from "./registry-db.js";
import { mcpLoginCommand } from "./login-options.js";

const log = logger.child("mcp:authorize");

export type McpSurface = "list" | "call" | "task-input" | "elicitation" | "skill" | "upload";

export const MCP_TOOL_SURFACES: readonly McpSurface[] = ["list", "call", "task-input", "elicitation", "upload"];

export type McpDenialCode =
  | "no_turn"
  | "not_registered"
  | "disabled"
  | "not_attached"
  | "audience"
  | "audience_legacy"
  | "capability"
  | "needs_login"
  | "invalid_request"
  | "error";

export interface AuthorizeMcpUseInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  server: string;
  /** The remote tool name (not the exposed `mcp__` name). Required on every tool surface except `list`. */
  tool?: string;
  surface: McpSurface;
}

export type McpAuthorization =
  | {
      allowed: true;
      server: McpServerRecord;
      attachment: McpAgentServerRecord;
      /** `list` without a tool: the exposed names of the catalog tools this turn may call, in catalog order. */
      tools?: string[];
    }
  | { allowed: false; code: McpDenialCode; reason: string };

export interface AuthorizeMcpUseDeps {
  getServer?: (name: string) => McpServerRecord | null;
  getAttachment?: (agentId: string, server: string) => McpAgentServerRecord | null;
  /** Whether the turn is the operator's own (default: isOperatorOwnTurn on the context record). */
  isOperatorOwnTurn?: (context: ContextRecord) => boolean;
  /** The `use tool:<name>` decision (default: the tool hook's decision). */
  canUseTool?: (context: ContextRecord, agentId: string, toolName: string) => boolean;
  /** Record a denial (default: the permission denial ledger). */
  recordDenial?: (input: McpDenialRecordInput) => void;
  now?: () => number;
}

export interface McpDenialRecordInput {
  context: ContextRecord | null | undefined;
  agentId: string;
  server: string;
  tool?: string;
  exposedName?: string;
  surface: McpSurface;
  code: McpDenialCode;
  reason: string;
}

function defaultIsOperatorOwnTurn(context: ContextRecord): boolean {
  return isOperatorOwnTurn({ turn: { runtimeContext: { present: true, record: context } } });
}

function defaultCanUseTool(context: ContextRecord, agentId: string, toolName: string): boolean {
  return canUseToolInContext(
    {
      agentId,
      contextId: context.contextId,
      context,
      kind: context.kind,
      sessionKey: context.sessionKey,
      sessionName: context.sessionName,
      source: context.source,
      capabilities: context.capabilities,
      metadata: context.metadata,
    },
    toolName,
  );
}

function deny(code: McpDenialCode, reason: string): McpAuthorization {
  return { allowed: false, code, reason };
}

function isLive(context: ContextRecord, now: number): boolean {
  if (context.revokedAt && context.revokedAt <= now) return false;
  if (context.expiresAt && context.expiresAt <= now) return false;
  return true;
}

/**
 * Whether the row uses the operator's credential: a bearer or OAuth login,
 * a full URL that itself carries a secret (a bridge URL with a token in it is
 * registered with auth `none`), or stdio environment values kept in the
 * credentials store (one declared env key is enough; the values are not read).
 * A stored key list that does not parse reads as `[MCP_DAMAGED_ENV_KEYS]`
 * (registry-db), so it counts as a credential; anything handed in that is not
 * a list counts as one too.
 */
export function mcpServerHoldsCredential(server: Pick<McpServerRecord, "authKind" | "urlSecret" | "envKeys">): boolean {
  if (server.authKind !== "none" || server.urlSecret !== false) return true;
  return !Array.isArray(server.envKeys) || server.envKeys.length > 0;
}

/**
 * A credentialed row that is, or may turn out to be, on the legacy leg. On
 * that leg a server may let the model confirm its own writes, so nobody else
 * may drive it. An era not yet probed counts as legacy unless the row pins
 * the modern revision.
 */
export function isLegacyCredentialedMcpServer(
  server: Pick<McpServerRecord, "authKind" | "urlSecret" | "envKeys" | "era" | "protocol">,
): boolean {
  if (!mcpServerHoldsCredential(server)) return false;
  if (server.protocol === "legacy") return true;
  if (server.protocol === "2026-07-28") return server.era === "legacy";
  return server.era !== "modern";
}

function evaluate(input: AuthorizeMcpUseInput, deps: AuthorizeMcpUseDeps): McpAuthorization & { exposedName?: string } {
  const now = (deps.now ?? Date.now)();
  const isToolSurface = MCP_TOOL_SURFACES.includes(input.surface);
  if (!isToolSurface && input.surface !== "skill") {
    return deny("invalid_request", `Unknown MCP surface ${JSON.stringify(input.surface)}.`);
  }
  if (input.surface !== "list" && isToolSurface && !input.tool) {
    return deny("invalid_request", `MCP surface ${input.surface} needs a tool name.`);
  }

  // 1. A turn: a live context record of this agent.
  const context = input.context;
  if (!context) {
    return deny("no_turn", "MCP servers are used only inside a turn Ravi issued; this call has no turn context.");
  }
  if (!isLive(context, now)) {
    return deny("no_turn", "The turn that asked for this MCP server has ended.");
  }
  if (context.agentId && context.agentId !== input.agentId) {
    return deny("no_turn", `The turn context belongs to agent ${context.agentId}, not ${input.agentId}.`);
  }

  // 2. Registered and enabled.
  const server = (deps.getServer ?? getMcpServer)(input.server);
  if (!server) return deny("not_registered", `MCP server ${input.server} is not registered in Ravi.`);
  if (!server.enabled) return deny("disabled", `MCP server ${server.name} is disabled.`);

  // 3. Attached to this agent.
  const attachment = (deps.getAttachment ?? getMcpAttachment)(input.agentId, server.name);
  if (!attachment) {
    return deny("not_attached", `MCP server ${server.name} is not attached to agent ${input.agentId}.`);
  }

  // 4. Audience.
  const legacyCredentialed = isLegacyCredentialedMcpServer(server);
  if (attachment.audience !== "any" || legacyCredentialed) {
    let ownTurn = false;
    try {
      ownTurn = (deps.isOperatorOwnTurn ?? defaultIsOperatorOwnTurn)(context) === true;
    } catch {
      // no-cause: a turn that cannot be classified is not the operator's own; the denial below is the outcome.
      ownTurn = false;
    }
    if (!ownTurn) {
      return attachment.audience !== "any"
        ? deny(
            "audience",
            `MCP server ${server.name} is for the operator's own turns only, and this turn is not one (or cannot be classified).`,
          )
        : deny(
            "audience_legacy",
            `MCP server ${server.name} uses the operator's credential on the legacy protocol, so only the operator's own turns may use it.`,
          );
    }
  }

  // 5. Capability, on the tool surfaces.
  let tools: string[] | undefined;
  let exposedName: string | undefined;
  if (isToolSurface) {
    const canUseTool = deps.canUseTool ?? defaultCanUseTool;
    if (input.tool !== undefined) {
      const exposed = exposedToolName(server.name, input.tool);
      if (!exposed.ok) {
        return deny(
          "capability",
          `Tool ${JSON.stringify(input.tool.slice(0, 80))} of ${server.name} is not exposed: ${exposed.reason}.`,
        );
      }
      exposedName = exposed.name;
      if (!canUseTool(context, input.agentId, exposed.name)) {
        return {
          ...deny("capability", `Permission denied: agent:${input.agentId} cannot use tool:${exposed.name}`),
          exposedName,
        };
      }
    } else {
      tools = [];
      for (const tool of mcpCatalogForAttachment(server, attachment)?.tools ?? []) {
        // Recomputed, never read from the stored row: a stored name grants nothing.
        const exposed = exposedToolName(server.name, tool.name);
        if (exposed.ok && canUseTool(context, input.agentId, exposed.name)) tools.push(exposed.name);
      }
      if (tools.length === 0) {
        return deny(
          "capability",
          `No tool of MCP server ${server.name} is granted to agent:${input.agentId} in this turn.`,
        );
      }
    }
  }

  // 6. Login.
  if (server.status === "needs_login") {
    return deny(
      "needs_login",
      `MCP server ${server.name} needs a login: run ${mcpLoginCommand(server.name, server.authKind)}`,
    );
  }

  return { allowed: true, server, attachment, ...(tools ? { tools } : {}) };
}

export function authorizeMcpUse(input: AuthorizeMcpUseInput, deps: AuthorizeMcpUseDeps = {}): McpAuthorization {
  let result: McpAuthorization & { exposedName?: string };
  try {
    result = evaluate(input, deps);
  } catch (error) {
    log.warn("MCP authorization failed closed", {
      server: typeof input.server === "string" ? input.server.slice(0, 64) : undefined,
      surface: input.surface,
      error: error instanceof Error ? error.name : typeof error,
    });
    result = deny("error", "The MCP authorization check failed, so the use is denied.");
  }
  if (result.allowed) {
    const { exposedName: _ignored, ...allowed } = result as McpAuthorization & { allowed: true; exposedName?: string };
    return allowed;
  }
  if (input.surface !== "list") {
    try {
      (deps.recordDenial ?? recordMcpDenial)({
        context: input.context,
        agentId: input.agentId,
        server: input.server,
        tool: input.tool,
        exposedName: result.exposedName,
        surface: input.surface,
        code: result.code,
        reason: result.reason,
      });
    } catch {
      // no-cause: the ledger failure must not replace the denial returned below, and its text may carry context.
      log.warn("MCP denial could not be recorded", { surface: input.surface, code: result.code });
    }
  }
  return { allowed: false, code: result.code, reason: result.reason };
}

/**
 * Record one MCP denial. A capability denial is recorded as the `use tool`
 * it lacks, so a later grant of that tool resolves it; every other denial is
 * recorded against the server (`use mcp_server:<name>`).
 */
export function recordMcpDenial(input: McpDenialRecordInput): void {
  const provenance = input.context ? buildAuditContextProvenance({ context: input.context }) : undefined;
  const serverName = typeof input.server === "string" ? input.server.slice(0, 64) : "unknown";
  const byTool = input.code === "capability" && input.exposedName !== undefined;
  const objectType = byTool ? "tool" : "mcp_server";
  const objectId = byTool ? input.exposedName! : serverName;
  const detail: Record<string, unknown> = {
    mcpServer: { name: serverName, source: "gateway" },
    mcpCode: input.code,
    mcpSurface: input.surface,
    ...(input.tool ? { mcpTool: input.tool.slice(0, 80) } : {}),
    ...(provenance ? { context: provenance } : {}),
  };
  recordAndEmitPermissionDenial({
    subjectType: "agent",
    subjectId: input.agentId,
    agentId: input.agentId,
    sessionKey: input.context?.sessionKey ?? null,
    sessionName: input.context?.sessionName ?? null,
    contextId: input.context?.contextId ?? null,
    relation: "use",
    objectType,
    objectId,
    reason: input.reason,
    detail,
    audit: {
      type: byTool ? "tool" : "mcp",
      agentId: input.agentId,
      denied: `${objectType}:${objectId}`,
      reason: input.reason,
      detail: { mcpServer: detail.mcpServer, mcpCode: input.code, mcpSurface: input.surface },
      ...(provenance ? { context: provenance } : {}),
    },
  });
}
