/**
 * `ravi mcp`: the registry of MCP servers an agent may reach (spec mcp,
 * Management CLI).
 *
 * Registering, attaching, enabling and widening are braked (dry run, exit 3,
 * act only with --execute) and run only on the operator's own turn. Changes
 * that only reduce authority (detach, disable, remove, narrowing `set`) apply
 * at once. Reads never print a secret: a server URL is shown only in its
 * display form, and stdio environment values are never shown.
 *
 * No command here connects to a server; the daemon probes a server after the
 * `ravi.config.changed` event a registry write emits.
 */

import "reflect-metadata";
import { homedir } from "node:os";
import { z } from "zod";

import { type AuthorizeMcpUseDeps, authorizeMcpUse, isLegacyCredentialedMcpServer } from "../../mcp/authorize.js";
import {
  listMcpToolsForTurn,
  MCP_CALL_REMOTE_TIMEOUT_MS,
  MCP_TOOLS_QUERY_MAX,
  mcpArgumentKeys,
  mcpCallFailureExit,
  mcpDenialExit,
  parseMcpCallInput,
  parseMcpCallWait,
  projectMcpCallResult,
  remoteMcpToolName,
  type McpCliCallResult,
} from "../../mcp/cli-pair.js";
import {
  discoverNativeMcpEntries,
  mcpImportEntryKey,
  planMcpImport,
  type McpImportFs,
  type McpImportPlan,
  type McpImportRegistered,
} from "../../mcp/import.js";
import {
  clearMcpServerRateLimit,
  countMcpCalls,
  getMcpCall,
  listMcpCalls,
  listMcpCallServerTools,
  MCP_CALL_ID_PATTERN,
  MCP_CALL_OPEN_STATES,
  MCP_CALL_OUTCOMES,
  MCP_CALL_STATES,
  mcpServerCallSummary,
  requestMcpCallCancel,
  requestMcpCallsCancelForServer,
  type ListMcpCallsFilter,
  type McpCallRecord,
  type McpCallState,
} from "../../mcp/calls-db.js";
import { mcpImportAgentsOf } from "../../mcp/import-agents.js";
import { MCP_SKILL_READ_TEXT_CAP_BYTES, MCP_SKILLS_LIST_MAX, McpSkillsError } from "../../mcp/skills-common.js";
import type { listMcpServerSkills, prepareMcpSkillPin } from "../../mcp/skills.js";
import type { McpLoginDeps, McpLoginResult } from "../../mcp/login.js";
import {
  checkMcpBearerToken,
  McpLoginError,
  type McpLoginErrorCode,
  mcpClientMetadataUrl,
  mcpLoginMethod,
  mcpLoginRedirectUrl,
  MCP_LOGIN_DEFAULT_PORT,
} from "../../mcp/login-options.js";
import {
  checkMcpServerName,
  McpServerNameError,
  McpServerUrlError,
  mcpDisplayUrl,
  MCP_TOOL_NAME_PREFIX,
  mcpInlineSecretArgIndex,
  mcpUrlCarriesSecret,
  parseMcpServerUrl,
} from "../../mcp/names.js";
import {
  attachMcpServer,
  bumpMcpCredentialRev,
  createMcpServer,
  detachMcpServer,
  getMcpAttachment,
  getMcpServer,
  listMcpAttachments,
  listMcpServers,
  MCP_AUDIENCES,
  MCP_AUTH_KINDS,
  MCP_PROTOCOL_MODES,
  McpRegistryError,
  removeMcpServer,
  updateMcpAttachments,
  updateMcpServerConfig,
  type McpAgentServerRecord,
  type McpAudience,
  type McpAuthKind,
  type McpProtocolMode,
  type McpServerRecord,
} from "../../mcp/registry-db.js";
import {
  deleteMcpServerSecret,
  hasMcpServerSecret,
  MCP_SECRET_MAX_BYTES,
  McpSecretError,
  readMcpServerSecret,
  writeMcpServerSecret,
  type McpServerSecret,
} from "../../mcp/secrets.js";
import { isOperatorOwnTurn } from "../../library/turn.js";
import { carriesRaviRuntimeEnvMarker } from "../../runtime/turn-origin.js";
import { HOST_MCP_IMPORT_FS } from "../../mcp/native-startup-warning.js";
import { resolveOperatorTurn } from "../../link/connector-turn.js";
import { canWithCapabilities, materializeSubjectCapabilities } from "../../permissions/provider-runtime.js";
import { enforceScopeCheck } from "../../permissions/scope.js";
import { resolveRuntimeDefaults } from "../../runtime/runtime-defaults.js";
import { getAgentRuntimePermissionsConfigFromDefaults } from "../../permissions/agent-default-capabilities-provider.js";
import { listMcpSkillPins } from "../../mcp/skill-pins-db.js";
import { type ContextRecord, dbGetAgent, dbListAgents } from "../../router/router-db.js";
import { errorDiagnostic } from "../../utils/error-diagnostic.js";
import { buildCommand, buildOffsetPagination } from "../../utils/pagination.js";
import {
  CONTRACT_EXIT_ERROR,
  CONTRACT_EXIT_POLICY,
  CONTRACT_EXIT_USAGE,
  ContractError,
  contractDryRun,
  contractFail,
  renderContractError,
  suggestSimilar,
} from "../agent-contract.js";
import { getContext } from "../context.js";
import { Arg, CliOnly, Command, CommandAccess, Group, Option, Returns, Scope } from "../decorators.js";
import {
  cliOnlyCommandError,
  dispatchRemote,
  remoteGatewayErrorToContractError,
  requiresRemoteGateway,
  resolveContextKeyForRemote,
  resolveRemoteGatewayConfig,
} from "../remote-gateway.js";
import { jsonObjectSchema } from "../return-schemas.js";

// ============================================================================
// Return schemas
// ============================================================================

const attachmentSchema = z
  .object({
    agentId: z.string(),
    audience: z.enum(["operator", "any"]),
    uploads: z.boolean(),
  })
  .strict();

const serverSummarySchema = z
  .object({
    name: z.string(),
    transport: z.enum(["http", "stdio"]),
    urlDisplay: z.string().nullable(),
    command: z.string().nullable(),
    authKind: z.enum(["none", "bearer", "oauth"]),
    protocol: z.enum(["auto", "2026-07-28", "legacy"]),
    enabled: z.boolean(),
    origin: z.string(),
    status: z.enum(["unknown", "ok", "needs_login", "error"]),
    era: z.enum(["modern", "legacy"]).nullable(),
    toolCount: z.number(),
    droppedCount: z.number(),
    attachments: z.array(attachmentSchema),
  })
  .strict();

const serverDetailSchema = serverSummarySchema
  .extend({
    args: z.array(z.string()),
    envKeys: z.array(z.string()),
    statusDetail: z.string().nullable(),
    extensions: jsonObjectSchema.nullable(),
    tools: z.array(z.object({ name: z.string(), exposedName: z.string() }).strict()),
    dropped: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
    catalogFingerprint: z.string().nullable(),
    checkedAt: z.number().nullable(),
    createdBy: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    secretStored: z.boolean(),
    login: z.enum(["not_needed", "logged_in", "needs_login", "unknown"]),
    /** When the stored OAuth access token expires (epoch ms); null without a stored lifetime or for a bearer token. */
    loginExpiresAt: z.number().nullable(),
    /** A refresh token is stored: Ravi renews an expired access token on use, without a new login. */
    loginRenews: z.boolean(),
  })
  .strict();

const listReturnSchema = z
  .object({
    total: z.number(),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        returned: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
        nextOffset: z.number().nullable(),
        nextCommand: z.string().nullable(),
      })
      .strict(),
    items: z.array(serverSummarySchema),
  })
  .strict();

const callsSummarySchema = z
  .object({
    open: z.number(),
    lastRateLimitedAt: z.number().nullable(),
    rateLimitedUntil: z.number().nullable(),
    rateLimitedMethod: z.string().nullable(),
  })
  .strict();

const showSkillSchema = z
  .object({
    agentId: z.string(),
    skillId: z.string(),
    skillName: z.string(),
    state: z.enum(["active", "stale"]),
    staleReason: z.enum(["manifest_changed", "digest_mismatch", "dynamic", "gone"]).nullable(),
    externalAllowed: z.boolean(),
  })
  .strict();

const uploadCatalogSchema = z
  .object({
    tools: z.array(
      z.object({ name: z.string(), exposedName: z.string(), fileArguments: z.array(z.string()) }).strict(),
    ),
    dropped: z.array(z.object({ name: z.string(), reason: z.string() }).strict()),
  })
  .strict();

const showReturnSchema = z
  .object({
    server: serverDetailSchema,
    calls: callsSummarySchema,
    /** Remote skills of this server pinned to agents. */
    skills: z.array(showSkillSchema),
    /** What attachments with uploads on see (the catalog listed with the files extension), or null. */
    uploadCatalog: uploadCatalogSchema.nullable(),
    /** Things the operator should know (an attached Claude agent without the ToolSearch grant). */
    warnings: z.array(z.string()),
  })
  .strict();

const addReturnSchema = z
  .object({
    server: serverSummarySchema,
    attached: z.array(z.string()),
    secretStored: z.boolean(),
  })
  .strict();

const attachReturnSchema = z
  .object({
    server: z.string(),
    agentId: z.string(),
    audience: z.enum(["operator", "any"]),
    uploads: z.boolean(),
    created: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

const detachReturnSchema = z
  .object({ server: z.string(), agentId: z.string(), detached: z.boolean(), skillPinsDropped: z.number() })
  .strict();

const enabledReturnSchema = z.object({ server: serverSummarySchema, changed: z.boolean() }).strict();

const setReturnSchema = z
  .object({
    server: serverSummarySchema,
    changed: z.boolean(),
    protocol: z
      .object({ from: z.enum(["auto", "2026-07-28", "legacy"]), to: z.enum(["auto", "2026-07-28", "legacy"]) })
      .strict()
      .nullable(),
    attachments: z.array(attachmentSchema),
  })
  .strict();

const removeReturnSchema = z
  .object({
    removed: serverSummarySchema,
    detachedAgents: z.array(z.string()),
    callsCancelled: z.number(),
    skillPinsDropped: z.number(),
    secretDeleted: z.boolean(),
    secretDeleteFailed: z.boolean(),
  })
  .strict();

const mcpCallViewSchema = z
  .object({
    id: z.string(),
    server: z.string(),
    tool: z.string(),
    agentId: z.string(),
    sessionName: z.string(),
    state: z.enum(MCP_CALL_STATES as [McpCallState, ...McpCallState[]]),
    outcome: z.enum(MCP_CALL_OUTCOMES as [string, ...string[]]).nullable(),
    detachReason: z.enum(["task", "budget"]),
    taskStatus: z.string().nullable(),
    cancelRequestedAt: z.number().nullable(),
    lastError: z.string().nullable(),
    createdAt: z.number(),
    updatedAt: z.number(),
    expiresAt: z.number(),
    deliveredAt: z.number().nullable(),
  })
  .strict();

const callsListReturnSchema = z
  .object({
    scope: z.enum(["all", "session"]),
    total: z.number(),
    calls: z.array(mcpCallViewSchema),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        returned: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
        nextOffset: z.number().nullable(),
        nextCommand: z.string().nullable(),
      })
      .strict(),
  })
  .strict();

const callsCancelReturnSchema = z
  .object({
    call: mcpCallViewSchema,
    cancelRequested: z.boolean(),
  })
  .strict();

const importSourceKindSchema = z.enum([
  "agent-mcp-json",
  "claude-user",
  "claude-project",
  "plugin",
  "codex-home",
  "codex-project",
]);

const importEntryRefSchema = z
  .object({
    kind: importSourceKindSchema,
    path: z.string(),
    scope: z.string().nullable(),
    nativeName: z.string(),
  })
  .strict();

/**
 * What an agent needs to see an imported server's tools (spec mcp, Import).
 * Nothing about grants is rewritten by an import: this only says which grant
 * applies under the registered name and who lacks it.
 */
const importGrantSchema = z
  .object({
    /** The grant that covers every tool of the server under its registered name. */
    capability: z.string(),
    /** Grant names written for the runtime's own server name, which do not match the registered name. */
    formerNames: z.array(z.string()),
    /** Always false: an import changes no grant. */
    grantsChanged: z.literal(false),
    /** Agents the server reaches whose ceiling does not cover `capability`, and the command that grants it. */
    agentsWithout: z.array(
      z.object({ agentId: z.string(), grantCommand: z.string().nullable(), note: z.string().nullable() }).strict(),
    ),
  })
  .strict();

const importReturnSchema = z
  .object({
    executed: z.boolean(),
    changed: z.boolean(),
    sources: z.array(
      z
        .object({
          kind: importSourceKindSchema,
          path: z.string(),
          scope: z.string().nullable(),
          agentIds: z.array(z.string()),
          status: z.enum(["read", "invalid"]),
          problem: z.string().nullable(),
          entries: z.number(),
        })
        .strict(),
    ),
    servers: z.array(
      z
        .object({
          name: z.string(),
          action: z.enum(["register", "attach", "unchanged"]),
          transport: z.enum(["http", "stdio"]),
          urlDisplay: z.string().nullable(),
          command: z.string().nullable(),
          args: z.array(z.string()),
          envKeys: z.array(z.string()),
          enabled: z.boolean(),
          origin: z.string(),
          agents: z.array(z.string()),
          attach: z.array(z.string()),
          audience: z.literal("operator"),
          from: z.array(importEntryRefSchema),
          grant: importGrantSchema,
          moves: z.array(z.string()),
          notes: z.array(z.string()),
        })
        .strict(),
    ),
    unsupported: z.array(importEntryRefSchema.extend({ reason: z.string() }).strict()),
    skipped: z.array(importEntryRefSchema.extend({ reason: z.string() }).strict()),
  })
  .strict();

const loginReturnSchema = z
  .object({
    server: z.string(),
    authKind: z.enum(["bearer", "oauth"]),
    registration: z.enum(["dynamic", "metadata_document", "preregistered"]).nullable(),
    era: z.enum(["modern", "legacy"]),
    toolCount: z.number(),
    scopes: z.array(z.string()),
    expiresAt: z.number().nullable(),
    previousGrant: z.enum(["revoked", "not_confirmed", "not_offered"]).nullable(),
  })
  .strict();

const logoutReturnSchema = z
  .object({
    server: z.string(),
    removed: z.boolean(),
    revocation: z.enum(["revoked", "not_confirmed", "not_offered"]),
    status: z.enum(["unknown", "ok", "needs_login", "error"]),
  })
  .strict();

const denialCodeSchema = z.enum([
  "no_turn",
  "not_registered",
  "disabled",
  "not_attached",
  "audience",
  "audience_legacy",
  "capability",
  "needs_login",
  "invalid_request",
  "error",
]);

const toolsReturnSchema = z
  .object({
    agentId: z.string(),
    server: z.string().nullable(),
    query: z.string().nullable(),
    /** Every tool that matched; `tools` holds those within the listing budget. */
    total: z.number(),
    tools: z.array(
      z
        .object({
          server: z.string(),
          name: z.string(),
          tool: z.string(),
          description: z.string().nullable(),
          inputSchema: jsonObjectSchema,
        })
        .strict(),
    ),
    /** Tools left out by the listing budget, per server. */
    omitted: z.array(z.object({ server: z.string(), count: z.number() }).strict()),
    /** What the budget left out and how to see it, or null. */
    note: z.string().nullable(),
    unavailable: z.array(z.object({ server: z.string(), code: denialCodeSchema, reason: z.string() }).strict()),
  })
  .strict();

const callReturnSchema = z
  .object({
    server: z.string(),
    tool: z.string(),
    name: z.string(),
    outcome: z.enum(["ok", "tool_error", "detached"]),
    callId: z.string().nullable(),
    content: z.array(
      z.union([
        z.object({ type: z.literal("text"), text: z.string() }).strict(),
        z
          .object({
            type: z.literal("omitted"),
            contentType: z.string(),
            mimeType: z.string().nullable(),
            bytes: z.number(),
          })
          .strict(),
      ]),
    ),
    structuredContent: jsonObjectSchema.nullable(),
    bytes: z.number(),
    truncated: z.boolean(),
    era: z.enum(["modern", "legacy"]),
    waitSeconds: z.number(),
  })
  .strict();

type ToolsPayload = z.infer<typeof toolsReturnSchema>;
type ServerSummary = z.infer<typeof serverSummarySchema>;
type ServerDetail = z.infer<typeof serverDetailSchema>;

// ============================================================================
// Projections (never a secret)
// ============================================================================

function attachmentView(attachment: McpAgentServerRecord): z.infer<typeof attachmentSchema> {
  return { agentId: attachment.agentId, audience: attachment.audience, uploads: attachment.uploads };
}

function serverSummary(server: McpServerRecord, attachments?: McpAgentServerRecord[]): ServerSummary {
  return {
    name: server.name,
    transport: server.transport,
    urlDisplay: server.urlDisplay,
    command: server.command,
    authKind: server.authKind,
    protocol: server.protocol,
    enabled: server.enabled,
    origin: server.origin,
    status: server.status,
    era: server.era,
    toolCount: server.catalog?.tools.length ?? 0,
    droppedCount: server.catalog?.dropped.length ?? 0,
    attachments: (attachments ?? listMcpAttachments({ server: server.name })).map(attachmentView),
  };
}

type LoginView = Pick<ServerDetail, "login" | "loginExpiresAt" | "loginRenews">;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nonEmptyString(value: unknown): boolean {
  return typeof value === "string" && value.length > 0;
}

/**
 * The login state `show` reports, from the stored login (spec mcp, Management
 * CLI): `not_needed` (auth none, or stdio), `needs_login` (the daemon marked
 * it, nothing is stored, or an access token expired with nothing to renew it),
 * `logged_in`, or `unknown` when the credentials store cannot be read. Only
 * the expiry time and whether a refresh token exists leave this function;
 * never a token.
 */
export function mcpLoginView(
  server: Pick<McpServerRecord, "authKind" | "status" | "transport">,
  secret: McpServerSecret | null | undefined,
  now: number = Date.now(),
): LoginView {
  const none: LoginView = { login: "needs_login", loginExpiresAt: null, loginRenews: false };
  if (server.transport !== "http" || server.authKind === "none") {
    return { login: "not_needed", loginExpiresAt: null, loginRenews: false };
  }
  if (server.status === "needs_login") return none;
  if (secret === undefined) return { login: "unknown", loginExpiresAt: null, loginRenews: false };
  if (server.authKind === "bearer") {
    return secret?.bearer ? { login: "logged_in", loginExpiresAt: null, loginRenews: false } : none;
  }
  const tokens = secret?.oauth?.tokens;
  if (!tokens || !nonEmptyString(tokens.access_token)) return none;
  const obtainedAt = finiteNumber(tokens.obtained_at);
  const expiresIn = finiteNumber(tokens.expires_in);
  const expiresAt = obtainedAt !== undefined && expiresIn !== undefined ? obtainedAt + expiresIn * 1000 : null;
  const renews = nonEmptyString(tokens.refresh_token);
  if (expiresAt !== null && expiresAt <= now && !renews) return { ...none, loginExpiresAt: expiresAt };
  return { login: "logged_in", loginExpiresAt: expiresAt, loginRenews: renews };
}

/** The stored secret, `null` when none is stored, `undefined` when the store cannot be read. */
async function readSecretForView(name: string): Promise<McpServerSecret | null | undefined> {
  try {
    return await readMcpServerSecret(name);
  } catch {
    // no-cause: an unreadable store is reported as login `unknown`; its error may name storage paths.
    return undefined;
  }
}

/** Extensions as the daemon recorded them, kept only when they are plain JSON. */
function jsonOnly(
  value: Record<string, unknown> | null,
): Record<string, z.infer<typeof jsonObjectSchema>[string]> | null {
  if (!value) return null;
  const parsed = jsonObjectSchema.safeParse(JSON.parse(JSON.stringify(value)));
  return parsed.success ? parsed.data : null;
}

function serverDetail(server: McpServerRecord, login: LoginView): ServerDetail {
  let secretStored = false;
  try {
    secretStored = hasMcpServerSecret(server.name);
  } catch {
    // no-cause: the credentials store is unreadable; `show` reports no stored secret rather than failing a read.
    secretStored = false;
  }
  return {
    ...serverSummary(server),
    args: server.args,
    envKeys: server.envKeys,
    statusDetail: server.statusDetail,
    extensions: jsonOnly(server.extensions),
    tools: (server.catalog?.tools ?? []).map((tool) => ({ name: tool.name, exposedName: tool.exposedName })),
    dropped: server.catalog?.dropped ?? [],
    catalogFingerprint: server.catalogFingerprint,
    checkedAt: server.checkedAt,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    secretStored,
    ...login,
  };
}

function printJson(payload: unknown): void {
  console.log(JSON.stringify(payload, null, 2));
}

function where(server: Pick<ServerSummary, "transport" | "urlDisplay" | "command">): string {
  return server.transport === "http" ? (server.urlDisplay ?? "-") : `stdio ${server.command ?? "-"}`;
}

function printSummary(server: ServerSummary): void {
  const flags = [server.enabled ? "enabled" : "disabled", `status=${server.status}`, `auth=${server.authKind}`];
  if (server.era) flags.push(`era=${server.era}`);
  console.log(`${server.name}  ${where(server)}  ${flags.join(" ")}`);
  const agents = server.attachments.map(
    (item) => `${item.agentId}(${item.audience}${item.uploads ? ", uploads" : ""})`,
  );
  console.log(`  agents: ${agents.length ? agents.join(", ") : "-"}`);
}

// ============================================================================
// Failures
// ============================================================================

interface FailOptions {
  asJson?: boolean;
  exitCode?: number;
  suggestedAction?: string;
  suggestions?: string[];
  acceptedValues?: readonly string[];
  /** Extra structured details (JSON-safe, never a secret). */
  details?: Record<string, unknown>;
}

function failMcp(op: string, code: string, message: string, options: FailOptions = {}): never {
  contractFail(op, code, message, {
    asJson: options.asJson,
    exitCode: options.exitCode ?? CONTRACT_EXIT_ERROR,
    details: {
      ...(options.suggestedAction ? { suggestedAction: options.suggestedAction } : {}),
      ...(options.suggestions ? { suggestions: options.suggestions } : {}),
      ...(options.acceptedValues ? { acceptedValues: [...options.acceptedValues] } : {}),
      ...(options.details ?? {}),
    },
    diagnostic: errorDiagnostic(message, { operation: op }),
  });
}

function usage(op: string, message: string, options: Omit<FailOptions, "exitCode"> = {}): never {
  failMcp(op, "USAGE_ERROR", message, { ...options, exitCode: CONTRACT_EXIT_USAGE });
}

/** Turn a registry, name, URL or secret error into the contract envelope. */
/**
 * Store the secret of a server this command has just registered. The row is
 * written first: its primary key claims the name, so a concurrent add of the
 * same name fails before it can overwrite this server's secret. When the
 * secret cannot be stored the new row goes too (it is this command's own row).
 * Afterwards the credential revision moves, which tells the daemon to re-read
 * the server now that its URL or env values exist.
 */
async function storeSecretForNewServer(name: string, secret: McpServerSecret): Promise<void> {
  try {
    await writeMcpServerSecret(name, secret);
  } catch (error) {
    try {
      removeMcpServer(name);
    } catch {
      // no-cause: the secret failure is the error to report; the row left behind has no secret and loads nothing.
    }
    throw error;
  }
  bumpMcpCredentialRev(name, 0);
}

function failFromError(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  if (error instanceof McpServerNameError) {
    failMcp(op, error.code === "reserved_name" ? "RESERVED_NAME" : "INVALID_NAME", error.message, {
      asJson,
      exitCode: CONTRACT_EXIT_USAGE,
    });
  }
  if (error instanceof McpServerUrlError) {
    failMcp(op, "INVALID_URL", error.message, { asJson, exitCode: CONTRACT_EXIT_USAGE });
  }
  if (error instanceof McpRegistryError) {
    const usageCodes = new Set(["invalid_value", "invalid_env_key"]);
    failMcp(op, error.code.toUpperCase(), error.message, {
      asJson,
      exitCode: usageCodes.has(error.code) ? CONTRACT_EXIT_USAGE : CONTRACT_EXIT_ERROR,
    });
  }
  if (error instanceof McpSecretError) {
    failMcp(op, error.code.toUpperCase(), error.message, { asJson });
  }
  // Anything else may quote input (a URL, a value): it never leaves as text.
  failMcp(op, "COMMAND_FAILED", "The MCP registry change could not be completed.", { asJson });
}

function requireServer(op: string, name: string, asJson?: boolean): McpServerRecord {
  const server = getMcpServer(name);
  if (server) return server;
  failMcp(op, "MCP_SERVER_NOT_FOUND", `MCP server not registered: ${JSON.stringify(name.slice(0, 64))}`, {
    asJson,
    suggestedAction: "List registered servers with: ravi mcp list --json",
    suggestions: suggestSimilar(
      name,
      listMcpServers().map((server) => server.name),
    ),
  });
}

function requireAgent(op: string, agentId: string, asJson?: boolean): string {
  const id = agentId.trim();
  if (id && dbGetAgent(id)) return id;
  failMcp(op, "AGENT_NOT_FOUND", `Agent not found: ${JSON.stringify(id.slice(0, 64))}`, {
    asJson,
    suggestedAction: "Check the agent id (list with: ravi agents list --json)",
    suggestions: suggestSimilar(
      id,
      dbListAgents().map((agent) => agent.id),
    ),
  });
}

/** A stdio child runs on the daemon host: an agent that runs on a remote host cannot use it. */
function refuseRemoteStdio(op: string, server: { name: string; transport: string }, agentId: string, asJson?: boolean) {
  if (server.transport !== "stdio") return;
  if (!dbGetAgent(agentId)?.remote) return;
  failMcp(
    op,
    "REMOTE_SPAWN_STDIO",
    `Agent ${agentId} runs on a remote host; the stdio MCP server ${server.name} runs on the daemon's host and cannot be attached to it.`,
    { asJson, exitCode: CONTRACT_EXIT_POLICY, suggestedAction: "Register an http server for remote agents" },
  );
}

/** Uploads read the agent's files on the daemon's host: a remote-spawn agent has none there. */
function refuseRemoteUploads(op: string, server: { name: string }, agentId: string, asJson?: boolean) {
  if (!dbGetAgent(agentId)?.remote) return;
  failMcp(
    op,
    "REMOTE_SPAWN_UPLOADS",
    `Agent ${agentId} runs on a remote host; its files are not on the daemon's host, so uploads to MCP server ${server.name} cannot be turned on for it.`,
    { asJson, exitCode: CONTRACT_EXIT_POLICY },
  );
}

/**
 * Whether an agent's own ceiling holds a capability: the capability snapshot
 * the runtime materializes for the agent's turns (bootstrap floor, profile and
 * explicit grants), not a provider-chain decision, which an operator CLI
 * process without a runtime context cannot make.
 */
export function agentCeilingAllows(agentId: string, permission: string, objectType: string, objectId: string): boolean {
  return canWithCapabilities(materializeSubjectCapabilities("agent", agentId), permission, objectType, objectId);
}

/**
 * Claude Code defers MCP tools behind its ToolSearch tool (spec mcp, Claude
 * Facade): an agent that runs on Claude without `use tool:ToolSearch` may
 * never reach a facade's tools. The deferral stays; the gap is reported.
 * The grant is read from the agent's materialized ceiling (agentCeilingAllows).
 */
export function mcpToolSearchWarnings(
  agentIds: readonly string[],
  deps: {
    getAgent?: (agentId: string) => { provider?: string | null } | null;
    defaultProvider?: () => string;
    can?: (agentId: string) => boolean;
  } = {},
): string[] {
  const warnings: string[] = [];
  for (const agentId of [...new Set(agentIds)].sort()) {
    try {
      const agent = (deps.getAgent ?? dbGetAgent)(agentId);
      if (!agent) continue;
      const provider = agent.provider || (deps.defaultProvider ?? (() => resolveRuntimeDefaults().provider.value))();
      if (provider !== "claude") continue;
      const granted = (deps.can ?? ((id: string) => agentCeilingAllows(id, "use", "tool", "ToolSearch")))(agentId);
      if (!granted) {
        warnings.push(
          `Agent ${agentId} runs on Claude without use tool:ToolSearch. Claude Code defers MCP tools behind ToolSearch, so this agent may never reach them: grant it use tool:ToolSearch.`,
        );
      }
    } catch {
      // no-cause: a warning that cannot be computed is left out; it never blocks the command.
    }
  }
  return warnings;
}

function showSkills(server: string): z.infer<typeof showSkillSchema>[] {
  try {
    return listMcpSkillPins({ server }).map((pin) => ({
      agentId: pin.agentId,
      skillId: pin.skillId,
      skillName: pin.skillName,
      state: pin.state,
      staleReason: pin.staleReason,
      externalAllowed: pin.externalAllowed,
    }));
  } catch {
    // no-cause: an unreadable pin table shows no pins; ravi mcp skills list reports the failure itself.
    return [];
  }
}

function uploadCatalogView(server: McpServerRecord): z.infer<typeof uploadCatalogSchema> | null {
  if (!server.filesCatalog) return null;
  return {
    tools: server.filesCatalog.tools.map((tool) => ({
      name: tool.name,
      exposedName: tool.exposedName,
      fileArguments: (tool.fileArguments ?? []).map((argument) => argument.name),
    })),
    dropped: server.filesCatalog.dropped,
  };
}

/**
 * Registering and widening are the operator's own decision: the terminal, the
 * operator's own direct chat, or the operator's relay. Contacts, routines and
 * agents are refused (exit 3) whatever `--execute` says. A classifier that
 * throws refuses too.
 */
function requireOperatorTurn(op: string, action: string, asJson?: boolean): string {
  let message = `Only the operator can ${action}, from their terminal or their own direct chat with the agent.`;
  try {
    const result = resolveOperatorTurn({ action, service: "MCP servers" });
    if (result.ok) return result.turn.actorPrincipal;
    message = result.error.message || message;
  } catch {
    // no-cause: a turn that cannot be classified is not the operator's; the fixed refusal below applies.
  }
  failMcp(op, "OPERATOR_TURN_REQUIRED", message, {
    asJson,
    exitCode: CONTRACT_EXIT_POLICY,
    suggestedAction: "Do not retry from this turn; the operator runs it from their terminal",
  });
}

/** A stdio server runs a command as the daemon's user, outside any agent sandbox. */
function requireSuperadmin(op: string, command: string, asJson?: boolean): void {
  let allowed = false;
  let message = "Permission denied: a stdio MCP server needs admin on system:*.";
  try {
    const result = enforceScopeCheck("superadmin", "mcp", command);
    allowed = result.allowed;
    if (!allowed && result.errorMessage)
      message = `${result.errorMessage} (stdio MCP servers run as the daemon's user)`;
  } catch {
    // no-cause: a scope check that throws denies; the fixed message below applies.
    allowed = false;
  }
  if (!allowed) failMcp(op, "PERMISSION_DENIED", message, { asJson, exitCode: CONTRACT_EXIT_ERROR });
}

// ============================================================================
// Inline secrets and stdin
// ============================================================================

const ENV_KEY = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

type StdinReader = () => Promise<string>;
let stdinReaderForTests: StdinReader | null = null;

/** Tests: replace stdin (null restores it). */
export function setMcpStdinReaderForTests(reader: StdinReader | null): void {
  stdinReaderForTests = reader;
}

/** stdin exists only in the operator's own CLI process, never in the daemon's gateway. */
function assertStdinAvailable(op: string, flag: string, asJson?: boolean): void {
  if (stdinReaderForTests) return;
  const transport = getContext({ localOnly: true })?.transport;
  if (transport === "gateway" || transport === "tool") {
    usage(op, `${flag} reads stdin, which only the operator's own terminal has.`, {
      asJson,
      suggestedAction: "Run the command in the operator's terminal",
    });
  }
}

async function readStdin(op: string, asJson?: boolean): Promise<string> {
  if (stdinReaderForTests) return stdinReaderForTests();
  if (process.stdin.isTTY) {
    usage(op, "Secret values are read from redirected stdin, not typed at a prompt.", {
      asJson,
      suggestedAction: "Pipe the values in, e.g. from a file with < values.env",
    });
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > MCP_SECRET_MAX_BYTES) usage(op, "stdin holds more than 64 KB.", { asJson });
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** `KEY=value` lines; blank lines and `#` comments are skipped. Each declared key exactly once. */
function parseEnvValues(op: string, text: string, keys: readonly string[], asJson?: boolean): Record<string, string> {
  const declared = new Set(keys);
  const values: Record<string, string> = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const separator = line.indexOf("=");
    const key = separator > 0 ? line.slice(0, separator).trim() : "";
    if (!ENV_KEY.test(key)) {
      usage(op, "Each stdin line must be KEY=value.", { asJson });
    }
    if (!declared.has(key)) {
      usage(op, `stdin sets ${key}, which no --env names.`, { asJson, acceptedValues: [...declared] });
    }
    if (Object.hasOwn(values, key)) usage(op, `stdin sets ${key} twice.`, { asJson });
    const value = line.slice(separator + 1);
    if (!value) usage(op, `stdin gives ${key} an empty value.`, { asJson });
    if (value.includes("\u0000")) usage(op, `The value of ${key} holds an invalid character.`, { asJson });
    values[key] = value;
  }
  const missing = keys.filter((key) => !Object.hasOwn(values, key));
  if (missing.length) usage(op, `stdin has no value for: ${missing.join(", ")}.`, { asJson });
  return values;
}

function parseChoice<T extends string>(
  op: string,
  flag: string,
  value: string | undefined,
  allowed: readonly T[],
  asJson?: boolean,
): T | undefined {
  if (value === undefined) return undefined;
  if ((allowed as readonly string[]).includes(value)) return value as T;
  usage(op, `${flag} must be one of: ${allowed.join(", ")}.`, { asJson, acceptedValues: allowed });
}

// ============================================================================
// Login
// ============================================================================

let loginDepsForTests: McpLoginDeps | null = null;

/** Tests: replace the login's browser, prompt, paste reader and network (null restores them). */
export function setMcpLoginDepsForTests(deps: McpLoginDeps | null): void {
  loginDepsForTests = deps;
}

/** What a revocation outcome means, for the operator. */
function revocationText(outcome: "revoked" | "not_confirmed" | "not_offered"): string {
  if (outcome === "revoked") return "the server confirmed it revoked the old grant";
  if (outcome === "not_confirmed")
    return "the server did not confirm it revoked the old grant; it may stay valid until it expires";
  return "the server offers no revocation; the old grant stays valid until it expires";
}

/** `--paste`: one line from the operator's terminal. */
async function readPastedLine(): Promise<string> {
  const { createInterface } = await import("node:readline");
  const reader = createInterface({ input: process.stdin, terminal: false });
  try {
    for await (const line of reader) {
      if (line.trim()) return line;
    }
  } finally {
    reader.close();
  }
  return "";
}

const LOGIN_USAGE_CODES = new Set<McpLoginErrorCode>(["not_http", "no_login_needed", "invalid_option"]);
const LOGIN_POLICY_CODES = new Set<McpLoginErrorCode>([
  "state_mismatch",
  "issuer_mismatch",
  "authorization_denied",
  "token_refused",
]);

function failLogin(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  if (error instanceof McpLoginError) {
    failMcp(op, error.code.toUpperCase(), error.message, {
      asJson,
      exitCode: LOGIN_USAGE_CODES.has(error.code)
        ? CONTRACT_EXIT_USAGE
        : LOGIN_POLICY_CODES.has(error.code)
          ? CONTRACT_EXIT_POLICY
          : CONTRACT_EXIT_ERROR,
    });
  }
  if (error instanceof McpSecretError) failMcp(op, error.code.toUpperCase(), error.message, { asJson });
  // Anything else may quote a token or a URL: it never leaves as text.
  failMcp(op, "LOGIN_FAILED", "The MCP login could not be completed; nothing was stored.", { asJson });
}

function parsePort(op: string, value: string | undefined, asJson?: boolean): number | undefined {
  if (value === undefined) return undefined;
  const port = /^\d{1,5}$/.test(value.trim()) ? Number.parseInt(value.trim(), 10) : Number.NaN;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    usage(op, "--port must be a port number from 1024 to 65535.", { asJson });
  }
  return port;
}

function asList(value: string[] | string | undefined): string[] {
  if (value === undefined) return [];
  const items = Array.isArray(value) ? value : [value];
  return items.map((item) => item.trim()).filter(Boolean);
}

// ============================================================================
// Import
// ============================================================================

interface ImportHost {
  homeDir: string;
  codexHome: string | null;
  fs: McpImportFs;
  pluginDirs?: string[];
}

let importHostForTests: ImportHost | null = null;

/** Tests: replace the home directory, Codex home, plugin roots and file reads (null restores the host). */
export function setMcpImportHostForTests(host: ImportHost | null): void {
  importHostForTests = host;
}

function importHost(): ImportHost {
  return (
    importHostForTests ?? { homeDir: homedir(), codexHome: process.env.CODEX_HOME ?? null, fs: HOST_MCP_IMPORT_FS }
  );
}

/** `--as old=new` pairs, keyed by the native name. */
function parseRenames(op: string, values: readonly string[], asJson?: boolean): Map<string, string> {
  const renames = new Map<string, string>();
  for (const value of values) {
    const separator = value.indexOf("=");
    const from = separator > 0 ? value.slice(0, separator).trim() : "";
    const to = separator > 0 ? value.slice(separator + 1).trim() : "";
    if (!from || !to) usage(op, "--as takes <native name>=<registry name>.", { asJson });
    if (renames.has(from)) usage(op, `--as renames ${JSON.stringify(from.slice(0, 64))} twice.`, { asJson });
    renames.set(from, to);
  }
  return renames;
}

/** Every registered server with its secret document, to compare full values in memory. */
async function loadRegisteredForImport(): Promise<McpImportRegistered[]> {
  const registered: McpImportRegistered[] = [];
  for (const server of listMcpServers()) {
    let secret: McpServerSecret | null = null;
    try {
      secret = await readMcpServerSecret(server.name);
    } catch {
      // no-cause: a server whose secret cannot be read matches no entry; the import then reports a name conflict instead of attaching to it.
      secret = null;
    }
    registered.push({
      name: server.name,
      origin: server.origin,
      transport: server.transport,
      urlDisplay: server.urlDisplay,
      command: server.command,
      args: server.args,
      envKeys: server.envKeys,
      secret,
    });
  }
  return registered;
}

type ImportGrant = z.infer<typeof importGrantSchema>;

/** One explicit capability as `ravi agents permissions --capabilities` takes it, or null when it cannot be written. */
function explicitCapabilityText(capability: unknown): string | null {
  if (typeof capability === "string") return capability.trim() || null;
  if (!capability || typeof capability !== "object") return null;
  const { permission, objectType, objectId } = capability as Record<string, unknown>;
  return typeof permission === "string" && typeof objectType === "string" && typeof objectId === "string"
    ? `${permission}:${objectType}:${objectId}`
    : null;
}

/** A single-quoted shell word. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * The exact command that adds `capability` to an agent's explicit grants,
 * keeping its profile and the grants it has (`--capabilities` replaces the
 * list), or why there is none.
 */
export function mcpGrantCommand(
  agentId: string,
  capability: string,
): { grantCommand: string | null; note: string | null } {
  const config = getAgentRuntimePermissionsConfigFromDefaults(dbGetAgent(agentId)?.defaults);
  if (config?.profile === "chat-only") {
    return { grantCommand: null, note: "a chat-only agent holds no tools; give it another profile first" };
  }
  const current: string[] = [];
  for (const entry of config?.capabilities ?? []) {
    const text = explicitCapabilityText(entry);
    if (text === null) {
      return {
        grantCommand: null,
        note: "its explicit grants cannot be listed again; add the grant with ravi agents permissions",
      };
    }
    current.push(text);
  }
  const list = [...new Set([...current, capability])].join(",");
  return {
    grantCommand: `ravi agents permissions ${agentId} --capabilities ${shellQuote(list)} --execute`,
    note: null,
  };
}

/**
 * The grant a server's tools need under its registered name (spec mcp,
 * Import): a facade and the CLI pair list a tool only to an agent that holds
 * `use tool:mcp__<name>__<tool>`. Agents whose ceiling already covers it
 * (the default bootstrap floor holds `use tool:*`) need nothing.
 */
export function mcpImportGrant(
  server: Pick<McpImportPlan["servers"][number], "name" | "agents" | "permissions">,
  deps: { allows?: (agentId: string, capability: string) => boolean } = {},
): ImportGrant {
  const objectId = `${MCP_TOOL_NAME_PREFIX}${server.name}__*`;
  const capability = `use:tool:${objectId}`;
  const allows = deps.allows ?? ((agentId: string) => agentCeilingAllows(agentId, "use", "tool", objectId));
  const agentsWithout: ImportGrant["agentsWithout"] = [];
  for (const agentId of server.agents) {
    let covered = false;
    try {
      covered = allows(agentId, capability);
    } catch {
      // no-cause: a ceiling that cannot be read is reported as not covering the grant.
      covered = false;
    }
    if (!covered) agentsWithout.push({ agentId, ...mcpGrantCommand(agentId, capability) });
  }
  return {
    capability,
    formerNames: [...new Set(server.permissions.map((item) => item.from).filter((name) => name !== objectId))],
    grantsChanged: false,
    agentsWithout,
  };
}

function importPayload(plan: McpImportPlan, sources: z.infer<typeof importReturnSchema>["sources"]) {
  return {
    sources,
    servers: plan.servers.map(({ permissions, ...server }) => ({
      ...server,
      audience: "operator" as const,
      grant: mcpImportGrant({ name: server.name, agents: server.agents, permissions }),
    })),
    unsupported: plan.unsupported,
    skipped: plan.skipped,
  };
}

function printImport(payload: z.infer<typeof importReturnSchema>): void {
  console.log(`Sources read: ${payload.sources.length}`);
  for (const source of payload.sources) {
    const scope = source.scope ? ` [${source.scope}]` : "";
    console.log(
      `  ${source.kind} ${source.path}${scope}: ${source.status === "read" ? `${source.entries} entries` : `invalid (${source.problem})`}`,
    );
  }
  for (const server of payload.servers) {
    const target = server.transport === "http" ? (server.urlDisplay ?? "-") : `stdio ${server.command ?? "-"}`;
    console.log(`${server.action} ${server.name}  ${target}${server.enabled ? "" : "  (disabled)"}`);
    if (server.transport === "stdio") {
      // What runs as the daemon's user: every argument (screened for inline secrets) and the env key names.
      console.log(`  args: ${server.args.length ? server.args.map((arg) => JSON.stringify(arg)).join(" ") : "-"}`);
      console.log(`  env keys: ${server.envKeys.length ? server.envKeys.join(", ") : "-"}`);
    }
    const former = server.grant.formerNames.length
      ? `; grants written for ${server.grant.formerNames.join(", ")} are not changed and do not match this name`
      : "";
    console.log(`  tools: an agent sees them only with ${server.grant.capability} (or a grant per tool)${former}`);
    if (!server.grant.agentsWithout.length) console.log("  every agent it reaches already holds that grant");
    for (const missing of server.grant.agentsWithout) {
      console.log(
        `  ${missing.agentId} lacks it: ${missing.grantCommand ?? missing.note ?? "grant it with ravi agents permissions"}`,
      );
    }
    console.log(`  agents: ${server.attach.length ? server.attach.join(", ") : "-"} (audience operator)`);
    if (server.moves.length) console.log(`  moves to the credentials store: ${server.moves.join(", ")}`);
    for (const note of server.notes) console.log(`  note: ${note}`);
  }
  for (const entry of payload.unsupported) {
    console.log(`not imported ${entry.nativeName} (${entry.path}): ${entry.reason}`);
  }
  for (const entry of payload.skipped) console.log(`skipped ${entry.nativeName} (${entry.path}): ${entry.reason}`);
}

// ============================================================================
// The CLI pair: `tools` and `call` run in the daemon
// ============================================================================

/** Whether this process runs the command for the daemon: its CLI gateway, or a runtime's dynamic tool. */
function runsInDaemon(): boolean {
  const transport = getContext({ localOnly: true })?.transport;
  return transport === "gateway" || transport === "tool";
}

/**
 * Whether a run outside the daemon may go to the daemon's CLI gateway: only
 * from a terminal. A process that holds a context of its own without a
 * transport (code inside the daemon), or that carries a runtime's markers
 * (a session's, a trigger's id, or the principal of a shell cron, shell
 * trigger or job) but no context key, would otherwise reach the gateway with
 * the operator's default credential; it is refused instead (fail closed).
 */
export function mcpTerminalForwardAllowed(
  stored: { context?: unknown; contextOrigin?: string } | undefined,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (stored?.context && stored.contextOrigin !== "default-credential") return false;
  if (env.RAVI_CONTEXT_KEY?.trim()) return true;
  return !carriesRaviRuntimeEnvMarker(env);
}

function refuseUnforwardable(op: string, asJson: boolean | undefined): never {
  failMcp(
    op,
    "MCP_NO_TURN",
    "This process runs for a session or an automation but carries no context key, so it cannot reach the Ravi daemon's MCP gateway; it never counts as the operator's terminal.",
    { asJson, exitCode: CONTRACT_EXIT_POLICY, suggestedAction: "Run it from a session turn of the agent" },
  );
}

interface McpTurnScope {
  context: ContextRecord | null;
  agentId: string;
}

/**
 * The turn a `tools` or `call` runs for: the context record the daemon
 * resolved from the caller's context key, and its agent. `--agent` only
 * names the agent of a context that has none (the operator's own credential,
 * checked as the operator's own turn); a turn of one agent never acts as
 * another.
 */
function resolveMcpTurnScope(op: string, agentOption: string | undefined, asJson?: boolean): McpTurnScope {
  const ctx = getContext({ localOnly: true });
  const context = ctx?.context ?? null;
  const contextAgent = (ctx?.agentId ?? context?.agentId ?? "").trim() || undefined;
  const requested = agentOption?.trim() || undefined;
  if (!context) {
    failMcp(op, "MCP_NO_TURN", "MCP servers are used only inside a turn Ravi issued; this call has no turn context.", {
      asJson,
      exitCode: CONTRACT_EXIT_POLICY,
      suggestedAction: "Run it from a session turn of the agent",
    });
  }
  if (contextAgent) {
    if (requested && requested !== contextAgent) {
      failMcp(
        op,
        "MCP_NO_TURN",
        `This turn belongs to agent ${contextAgent}; it cannot use the MCP servers of ${JSON.stringify(requested.slice(0, 64))}.`,
        { asJson, exitCode: CONTRACT_EXIT_POLICY, suggestedAction: "Leave out --agent" },
      );
    }
    return { context, agentId: contextAgent };
  }
  if (!requested) {
    usage(op, "This context belongs to no agent: name the agent whose MCP servers to use with --agent <id>.", {
      asJson,
    });
  }
  const agentId = requireAgent(op, requested, asJson);
  let ownTurn = false;
  try {
    ownTurn = isOperatorOwnTurn({ turn: { runtimeContext: { present: true, record: context } } });
  } catch {
    // no-cause: a context that cannot be classified is not the operator's own; the refusal below applies.
    ownTurn = false;
  }
  if (!ownTurn) {
    failMcp(op, "OPERATOR_TURN_REQUIRED", "Only the operator's own context may act for an agent with --agent.", {
      asJson,
      exitCode: CONTRACT_EXIT_POLICY,
      suggestedAction: "Run it from a session turn of the agent",
    });
  }
  return { context, agentId };
}

/** Connection errors raised before a request leaves this process: nothing reached the daemon. */
const MCP_FORWARD_PRE_SEND_ERRORS = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
  "ENOTSOCK",
  "ENOTDIR",
  "EADDRNOTAVAIL",
  "ConnectionRefused",
  "FailedToOpenSocket",
]);

/**
 * Whether a forwarding failure happened before the request was sent (the
 * daemon's socket refused or was missing), so a resend cannot run a tool
 * twice. Anything else (a reset, a timeout, a daemon that stopped mid-call)
 * leaves the outcome unknown.
 */
export function mcpForwardFailedBeforeSend(error: unknown): boolean {
  const code = error && typeof error === "object" ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && MCP_FORWARD_PRE_SEND_ERRORS.has(code);
}

/**
 * From a terminal, `tools` and `call` go to the daemon's CLI gateway with the
 * terminal's context credential: there is one MCP client, in the daemon. With
 * no daemon (or no credential) they fail and say so; nothing connects here.
 */
async function forwardToDaemon(
  op: string,
  command: string,
  body: Record<string, unknown>,
  asJson: boolean | undefined,
  timeoutMs?: number,
  groupSegments: readonly string[] = ["mcp"],
): Promise<unknown> {
  const label = [...groupSegments, command].join(" ");
  if (!mcpTerminalForwardAllowed(getContext({ localOnly: true }))) refuseUnforwardable(op, asJson);
  let config: Awaited<ReturnType<typeof resolveRemoteGatewayConfig>>;
  try {
    config = await resolveRemoteGatewayConfig(process.env, op, { installedOperator: true });
  } catch (error) {
    if (error instanceof ContractError) {
      renderContractError(error, asJson);
      throw error;
    }
    failMcp(op, "MCP_DAEMON_REQUIRED", "The Ravi gateway address could not be read.", { asJson });
  }
  if (!config) {
    failMcp(
      op,
      "MCP_DAEMON_REQUIRED",
      `ravi ${label} runs in the Ravi daemon, which holds the MCP connections, and no running daemon was found (its CLI gateway socket is not reachable).`,
      {
        asJson,
        suggestedAction: "Start the Ravi daemon (ravi daemon start) and retry",
        details: { retryable: true },
      },
    );
  }
  const contextKey = resolveContextKeyForRemote();
  if (!contextKey) {
    failMcp(
      op,
      "MCP_CONTEXT_REQUIRED",
      `ravi ${label} runs in the Ravi daemon for a turn context, and this terminal has no context credential.`,
      {
        asJson,
        suggestedAction: "Add a default context credential (ravi context credentials add) and retry",
      },
    );
  }
  let result: Awaited<ReturnType<typeof dispatchRemote>>;
  try {
    result = await dispatchRemote({
      groupSegments: [...groupSegments],
      command,
      body,
      config,
      contextKey,
      cwd: process.cwd(),
      ...(timeoutMs ? { timeoutMs } : {}),
    });
  } catch (error) {
    // no-cause: a transport failure may quote the socket path or the request; the fixed text below is the outcome.
    if (command === "call" && !mcpForwardFailedBeforeSend(error)) {
      // The request may have reached the daemon and run the tool: resending could run it twice.
      failMcp(
        op,
        "MCP_CALL_OUTCOME_UNKNOWN",
        "The connection to the Ravi daemon ended before it answered ravi mcp call; the call may have run, and its outcome is unknown.",
        {
          asJson,
          suggestedAction:
            "Do not call it again blindly: the outcome on the server is unknown. Check the daemon (ravi daemon status) and the server's state first",
          details: { retryable: false },
        },
      );
    }
    failMcp(op, "MCP_DAEMON_REQUIRED", `The Ravi daemon did not answer ravi ${label}.`, {
      asJson,
      suggestedAction: "Check the daemon (ravi daemon status) and retry",
      details: { retryable: true },
    });
  }
  const remoteError = remoteGatewayErrorToContractError(op, result);
  if (remoteError) {
    renderContractError(remoteError, asJson);
    throw remoteError;
  }
  try {
    return JSON.parse(result.body) as unknown;
  } catch {
    // no-cause: the body may quote remote content; the fixed text below is the outcome.
    failMcp(op, "GATEWAY_RESPONSE_INVALID", `The Ravi daemon answered ravi ${label} with invalid JSON.`, {
      asJson,
    });
  }
}

/** What a `needs_login` answer tells the model to relay: only the operator signs in. */
function mcpLoginHint(server: string): string {
  return `Ask the operator to sign in from their terminal: ravi mcp login ${server} --execute`;
}

function printTools(payload: ToolsPayload): void {
  const shown =
    payload.tools.length === payload.total ? `${payload.total}` : `${payload.tools.length} of ${payload.total}`;
  console.log(`MCP tools for ${payload.agentId} (${shown})`);
  for (const tool of payload.tools) {
    const description = tool.description ? `  ${tool.description.split("\n", 1)[0]}` : "";
    console.log(`${tool.name}${description}`);
  }
  if (payload.note) console.log(payload.note);
  for (const item of payload.unavailable) console.log(`unavailable ${item.server} (${item.code}): ${item.reason}`);
  if (payload.tools.length) {
    console.log("Call one with: ravi mcp call <server> <tool> --input '<json>' --execute");
  }
}

function printCall(payload: McpCliCallResult): void {
  if (payload.outcome === "tool_error") console.log(`[tool error from ${payload.name}]`);
  if (payload.outcome === "detached") console.log(`[continues in the background as ${payload.callId}]`);
  let text = false;
  for (const item of payload.content) {
    if (item.type === "text") {
      text = true;
      console.log(item.text);
    } else {
      console.log(
        `[${item.contentType} content${item.mimeType ? `, ${item.mimeType}` : ""}, ${item.bytes} bytes, not shown]`,
      );
    }
  }
  if (payload.structuredContent && !text) console.log(JSON.stringify(payload.structuredContent, null, 2));
  if (payload.truncated) console.log("[some content was cut or left out by a size cap]");
}

// ============================================================================
// Commands
// ============================================================================

@Group({
  name: "mcp",
  description: "Register MCP servers and attach them to agents",
  scope: "admin",
})
export class McpCommands {
  @Command({ name: "list", description: "List registered MCP servers and the agents they are attached to" })
  @CommandAccess({ kind: "read", resource: "mcp.servers", action: "list", risk: "low" })
  @Returns(listReturnSchema)
  list(
    @Option({ flags: "--agent <id>", description: "Only servers attached to this agent" }) agent?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset", defaultValue: "0" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp list";
    const pageLimit = Number(limit ?? "50");
    const pageOffset = Number(offset ?? "0");
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > 500) {
      usage(op, "--limit must be an integer from 1 to 500.", { asJson });
    }
    if (!Number.isInteger(pageOffset) || pageOffset < 0)
      usage(op, "--offset must be a non-negative integer.", { asJson });
    const agentId = agent?.trim() || undefined;
    const attachments = listMcpAttachments(agentId ? { agentId } : {});
    const byServer = new Map<string, McpAgentServerRecord[]>();
    for (const attachment of agentId ? listMcpAttachments() : attachments) {
      byServer.set(attachment.server, [...(byServer.get(attachment.server) ?? []), attachment]);
    }
    const attachedToAgent = new Set(attachments.map((item) => item.server));
    const servers = listMcpServers().filter((server) => !agentId || attachedToAgent.has(server.name));
    const page = servers.slice(pageOffset, pageOffset + pageLimit);
    const items = page.map((server) => serverSummary(server, byServer.get(server.name) ?? []));
    const payload = {
      total: servers.length,
      pagination: buildOffsetPagination({
        limit: pageLimit,
        offset: pageOffset,
        returned: items.length,
        total: servers.length,
        nextCommand: (nextOffset) =>
          buildCommand([
            "ravi",
            "mcp",
            "list",
            agentId && "--agent",
            agentId,
            "--limit",
            pageLimit,
            "--offset",
            nextOffset,
          ]),
      }),
      items,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`MCP servers (${items.length}/${servers.length})`);
    for (const item of items) printSummary(item);
    if (payload.pagination.nextCommand) console.log(`Next: ${payload.pagination.nextCommand}`);
    return payload;
  }

  @Command({
    name: "show",
    description: "Show one MCP server: status, era, extensions, tools, dropped tools and login state (never a token)",
  })
  @CommandAccess({ kind: "read", resource: "mcp.servers", action: "show", risk: "low" })
  @Returns(showReturnSchema)
  async show(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const record = requireServer("mcp show", name, asJson);
    const needsSecret = record.transport === "http" && record.authKind !== "none" && record.status !== "needs_login";
    const server = serverDetail(
      record,
      mcpLoginView(record, needsSecret ? await readSecretForView(record.name) : null),
    );
    const payload = {
      server,
      calls: mcpServerCallSummary(server.name),
      skills: showSkills(server.name),
      uploadCatalog: uploadCatalogView(record),
      warnings: mcpToolSearchWarnings(server.attachments.map((item) => item.agentId)),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSummary(server);
    const loginText =
      server.login === "logged_in" && server.loginExpiresAt !== null
        ? `logged_in (access token ${server.loginExpiresAt <= Date.now() ? "expired" : "expires"} ${new Date(server.loginExpiresAt).toISOString()}${server.loginRenews ? ", renewed on use" : ""})`
        : server.login;
    console.log(`  protocol: ${server.protocol}  origin: ${server.origin}  login: ${loginText}`);
    if (server.transport === "stdio") {
      console.log(`  args: ${server.args.length ? server.args.join(" ") : "-"}`);
      console.log(`  env keys: ${server.envKeys.length ? server.envKeys.join(", ") : "-"}`);
    }
    if (server.statusDetail) console.log(`  detail: ${server.statusDetail}`);
    console.log(`  extensions: ${server.extensions ? Object.keys(server.extensions).join(", ") || "-" : "-"}`);
    console.log(`  tools (${server.tools.length}): ${server.tools.map((tool) => tool.exposedName).join(", ") || "-"}`);
    for (const dropped of server.dropped) console.log(`  dropped ${dropped.name}: ${dropped.reason}`);
    if (payload.uploadCatalog) {
      const withFiles = payload.uploadCatalog.tools.filter((tool) => tool.fileArguments.length > 0);
      console.log(
        `  with uploads on (${payload.uploadCatalog.tools.length} tools): file arguments in ${withFiles.map((tool) => `${tool.exposedName}(${tool.fileArguments.join(", ")})`).join(", ") || "-"}`,
      );
      for (const dropped of payload.uploadCatalog.dropped)
        console.log(`  dropped with uploads ${dropped.name}: ${dropped.reason}`);
    }
    console.log(`  pinned skills: ${payload.skills.length ? "" : "-"}`);
    for (const pin of payload.skills) {
      console.log(
        `    ${pin.skillId} -> ${pin.agentId} as ravi-library:${pin.skillName} [${pin.state}${pin.staleReason ? `: ${pin.staleReason}` : ""}${pin.externalAllowed ? ", external" : ""}]`,
      );
    }
    console.log(`  background calls open: ${payload.calls.open}`);
    if (payload.calls.lastRateLimitedAt !== null) {
      console.log(
        `  last rate limit (HTTP 429): ${new Date(payload.calls.lastRateLimitedAt).toISOString()} on ${payload.calls.rateLimitedMethod}, until ${new Date(payload.calls.rateLimitedUntil ?? payload.calls.lastRateLimitedAt).toISOString()}`,
      );
    }
    for (const warning of payload.warnings) console.log(`  warning: ${warning}`);
    return payload;
  }

  @Command({
    name: "add",
    description: "Register an MCP server (http URL or stdio command); dry-run unless --execute",
    helpAfter: `
RULES
  Only the operator registers servers, from their terminal or their own direct chat.
  A URL that carries a token (a long path segment, a query, user info) is read from
  stdin with --url-stdin; it is kept in the credentials store, never in ravi.db.
  stdio servers need admin on system:*; their env values are read from stdin as
  KEY=value lines, never given on the command line.
  An argument that starts with "-" is passed as --arg=<value>.

EXAMPLES
  ravi mcp add docs --url https://mcp.example.com/mcp --agent main --execute
  ravi mcp add console --url-stdin --auth oauth --execute < console-url.txt
  ravi mcp add files --command npx --arg=-y --arg @scope/files-server --env FILES_TOKEN --execute < files.env`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "add",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["url"],
  })
  @Returns(addReturnSchema)
  async add(
    @Arg("name", { description: "Server name: lowercase letters, digits and hyphens" }) name: string,
    @Option({ flags: "--url <url>", description: "https URL of an http server (no token in it)" }) url?: string,
    @Option({ flags: "--url-stdin", description: "Read the server URL from stdin (a URL that carries a token)" })
    urlStdin?: boolean,
    @Option({ flags: "--command <cmd>", description: "Command of a stdio server" }) command?: string,
    @Option({ flags: "--arg <value...>", description: "Argument of the stdio command (repeatable)" })
    args?: string[],
    @Option({ flags: "--env <key...>", description: "Environment key of the stdio command; values come from stdin" })
    envKeys?: string[],
    @Option({ flags: "--auth <kind>", description: "none (default), bearer or oauth (http only)" }) auth?: string,
    @Option({ flags: "--protocol <mode>", description: "auto (default), 2026-07-28 or legacy" }) protocol?: string,
    @Option({ flags: "--agent <id...>", description: "Attach to this agent with audience operator (repeatable)" })
    agents?: string[],
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually register the server; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp add";
    const nameCheck = checkMcpServerName(name);
    if (!nameCheck.ok) failFromError(op, nameCheck.error, asJson);
    const serverName = nameCheck.name;
    const commandValue = command?.trim() || undefined;
    const argList = Array.isArray(args) ? args : args === undefined ? [] : [args];
    const envList = asList(envKeys);
    const transportCount = [url !== undefined, urlStdin === true, commandValue !== undefined].filter(Boolean).length;
    if (transportCount !== 1) {
      usage(op, "Give exactly one of --url, --url-stdin or --command.", {
        asJson,
        acceptedValues: ["--url", "--url-stdin", "--command"],
      });
    }
    const transport = commandValue ? "stdio" : "http";
    const authKind = parseChoice<McpAuthKind>(op, "--auth", auth, MCP_AUTH_KINDS, asJson) ?? "none";
    const protocolMode = parseChoice<McpProtocolMode>(op, "--protocol", protocol, MCP_PROTOCOL_MODES, asJson) ?? "auto";

    let urlDisplay: string | null = null;
    if (transport === "http") {
      if (argList.length || envList.length) usage(op, "--arg and --env apply only to a stdio server.", { asJson });
      if (url !== undefined) {
        let parsed: URL;
        try {
          parsed = parseMcpServerUrl(url);
        } catch (error) {
          failFromError(op, error, asJson);
        }
        if (mcpUrlCarriesSecret(parsed)) {
          failMcp(
            op,
            "INLINE_SECRET",
            "The URL carries what may be a secret (a long path segment, a query or user info); it must not be given on the command line.",
            {
              asJson,
              exitCode: CONTRACT_EXIT_USAGE,
              suggestedAction: `Pipe the URL in instead: ravi mcp add ${serverName} --url-stdin --execute < url.txt`,
            },
          );
        }
        urlDisplay = mcpDisplayUrl(parsed);
      }
    } else {
      if (authKind !== "none") {
        usage(op, "A stdio server has no bearer or OAuth login; pass its secrets with --env.", { asJson });
      }
      for (const key of envList) {
        if (key.includes("=")) {
          failMcp(op, "INLINE_SECRET", "--env takes a key name only; values are read from stdin as KEY=value lines.", {
            asJson,
            exitCode: CONTRACT_EXIT_USAGE,
            suggestedAction: `ravi mcp add ${serverName} --command <cmd> --env <KEY> --execute < values.env`,
          });
        }
        if (!ENV_KEY.test(key))
          usage(op, `--env ${JSON.stringify(key.slice(0, 64))} is not an environment key name.`, { asJson });
      }
      const secretArg = mcpInlineSecretArgIndex(argList);
      if (secretArg !== null) {
        failMcp(
          op,
          "INLINE_SECRET",
          `--arg number ${secretArg + 1} looks like a secret value; give secrets to a stdio server through --env and stdin.`,
          { asJson, exitCode: CONTRACT_EXIT_USAGE },
        );
      }
    }
    const envKeyList = [...new Set(envList)].sort();
    const agentIds = [...new Set(asList(agents))].map((agent) => requireAgent(op, agent, asJson));
    for (const agentId of agentIds) refuseRemoteStdio(op, { name: serverName, transport }, agentId, asJson);
    if (getMcpServer(serverName)) {
      failMcp(op, "ALREADY_REGISTERED", `MCP server "${serverName}" is already registered.`, {
        asJson,
        suggestedAction: `Inspect it with: ravi mcp show ${serverName}`,
      });
    }
    const needsStdin = urlStdin === true || envKeyList.length > 0;
    if (needsStdin) assertStdinAvailable(op, urlStdin ? "--url-stdin" : "--env", asJson);
    // stdin is read and checked before the brake, so the dry run shows only a plan --execute can carry out:
    // the URL in its display form and the env keys received, never a value.
    let stdinUrl: URL | null = null;
    let stdinEnv: Record<string, string> | null = null;
    if (urlStdin) {
      const text = (await readStdin(op, asJson)).trim();
      if (!text || text.includes("\n")) usage(op, "stdin must hold exactly one URL.", { asJson });
      let parsed: URL;
      try {
        parsed = parseMcpServerUrl(text);
      } catch (error) {
        failFromError(op, error, asJson);
      }
      stdinUrl = parsed;
      urlDisplay = mcpDisplayUrl(parsed);
    } else if (envKeyList.length) {
      stdinEnv = parseEnvValues(op, await readStdin(op, asJson), envKeyList, asJson);
    }

    const createdBy = requireOperatorTurn(op, "register an MCP server", asJson);
    if (transport === "stdio") requireSuperadmin(op, "add", asJson);

    if (execute !== true) {
      contractDryRun(
        op,
        {
          name: serverName,
          transport,
          ...(transport === "http"
            ? { urlDisplay, auth: authKind }
            : { command: commandValue, args: argList, envKeys: envKeyList }),
          protocol: protocolMode,
          agents: agentIds,
          audience: "operator",
          fromStdin: stdinUrl ? ["url"] : Object.keys(stdinEnv ?? {}).map((key) => `env ${key}`),
          connects: false,
        },
        { asJson },
      );
    }

    let secret: McpServerSecret;
    if (transport === "http") {
      let parsed: URL;
      try {
        parsed = stdinUrl ?? parseMcpServerUrl(url as string);
      } catch (error) {
        failFromError(op, error, asJson);
      }
      urlDisplay = mcpDisplayUrl(parsed);
      secret = { url: parsed.toString() };
    } else {
      secret = stdinEnv ? { env: stdinEnv } : {};
    }

    // Row first, secret second (storeSecretForNewServer says why).
    let created: McpServerRecord;
    try {
      created =
        transport === "http"
          ? createMcpServer({
              name: serverName,
              transport: "http",
              url: secret.url as string,
              authKind,
              protocol: protocolMode,
              createdBy,
            })
          : createMcpServer({
              name: serverName,
              transport: "stdio",
              command: commandValue as string,
              args: argList,
              envKeys: envKeyList,
              protocol: protocolMode,
              createdBy,
            });
    } catch (error) {
      failFromError(op, error, asJson);
    }
    try {
      await storeSecretForNewServer(serverName, secret);
    } catch (error) {
      failFromError(op, error, asJson);
    }
    created = getMcpServer(serverName) ?? created;
    const attached: string[] = [];
    for (const agentId of agentIds) {
      try {
        attachMcpServer({ agentId, server: serverName, audience: "operator", createdBy });
        attached.push(agentId);
      } catch (error) {
        failFromError(op, error, asJson);
      }
    }
    const payload = { server: serverSummary(created), attached, secretStored: true };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Registered MCP server ${created.name} (${where(payload.server)})`);
    if (attached.length) console.log(`Attached to: ${attached.join(", ")}`);
    return payload;
  }

  @Command({ name: "attach", description: "Attach a registered MCP server to an agent; dry-run unless --execute" })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "attach",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(attachReturnSchema)
  attach(
    @Arg("name", { description: "Server name" }) name: string,
    @Arg("agent", { description: "Agent id" }) agent: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually attach; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp attach";
    const server = requireServer(op, name, asJson);
    const agentId = requireAgent(op, agent, asJson);
    refuseRemoteStdio(op, server, agentId, asJson);
    const createdBy = requireOperatorTurn(op, "attach an MCP server to an agent", asJson);
    if (server.transport === "stdio") requireSuperadmin(op, "attach", asJson);
    const existing = getMcpAttachment(agentId, server.name);
    if (existing) {
      const payload = {
        server: server.name,
        ...attachmentView(existing),
        created: false,
        warnings: mcpToolSearchWarnings([agentId]),
      };
      return this.printAttach(payload, asJson);
    }
    if (execute !== true) {
      contractDryRun(
        op,
        {
          server: server.name,
          agentId,
          audience: "operator",
          uploads: false,
          transport: server.transport,
          warnings: mcpToolSearchWarnings([agentId]),
        },
        { asJson },
      );
    }
    let attachment: McpAgentServerRecord;
    try {
      attachment = attachMcpServer({ agentId, server: server.name, audience: "operator", createdBy }).attachment;
    } catch (error) {
      failFromError(op, error, asJson);
    }
    return this.printAttach(
      { server: server.name, ...attachmentView(attachment), created: true, warnings: mcpToolSearchWarnings([agentId]) },
      asJson,
    );
  }

  private printAttach(payload: z.infer<typeof attachReturnSchema>, asJson?: boolean) {
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      payload.created
        ? `Attached ${payload.server} to ${payload.agentId} (audience ${payload.audience})`
        : `${payload.server} is already attached to ${payload.agentId} (audience ${payload.audience})`,
    );
    for (const warning of payload.warnings) console.log(`Warning: ${warning}`);
    return payload;
  }

  @Command({ name: "detach", description: "Detach an MCP server from an agent (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "mcp.servers", action: "detach", risk: "medium" })
  @Returns(detachReturnSchema)
  async detach(
    @Arg("name", { description: "Server name" }) name: string,
    @Arg("agent", { description: "Agent id" }) agent: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp detach";
    const server = requireServer(op, name, asJson);
    const agentId = agent.trim();
    if (!detachMcpServer(agentId, server.name)) {
      failMcp(
        op,
        "NOT_ATTACHED",
        `MCP server ${server.name} is not attached to ${JSON.stringify(agentId.slice(0, 64))}.`,
        {
          asJson,
          suggestions: suggestSimilar(
            agentId,
            listMcpAttachments({ server: server.name }).map((item) => item.agentId),
          ),
        },
      );
    }
    // Its remote skill pins for that agent go too: a re-attach needs a new approval.
    const skillPinsDropped = (await mcpSkills()).dropMcpSkillPinsForServer(server.name, agentId);
    const payload = { server: server.name, agentId, detached: true, skillPinsDropped };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Detached ${server.name} from ${agentId}`);
    if (skillPinsDropped) console.log(`Remote skill pins dropped: ${skillPinsDropped}`);
    return payload;
  }

  @Command({
    name: "set",
    description: "Change audience, uploads or protocol; widening is a dry-run unless --execute",
    helpAfter: `
RULES
  Widening (--audience any, --uploads on, any --protocol change) is a dry-run (exit 3)
  until --execute, and only the operator may do it. Narrowing applies at once.
  --audience any is refused for a server with a login that is, or may be, on the
  legacy protocol: there a server may let the model confirm its own writes.
  Without --agent, --audience changes every attachment of the server.

EXAMPLES
  ravi mcp set docs --audience any --execute
  ravi mcp set docs --uploads on --agent main --execute
  ravi mcp set console --protocol 2026-07-28 --execute
  ravi mcp set docs --audience operator
  ravi mcp set docs --uploads off`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "set",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(setReturnSchema)
  set(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--audience <who>", description: "operator (narrow) or any (widen)" }) audience?: string,
    @Option({ flags: "--uploads <state>", description: "on (widen, needs --agent) or off (narrow)" }) uploads?: string,
    @Option({ flags: "--agent <id>", description: "Only this agent's attachment" }) agent?: string,
    @Option({ flags: "--protocol <mode>", description: "auto, 2026-07-28 or legacy (braked)" }) protocol?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually widen; default is a dry-run that only shows the plan (exit 3). Narrowing applies at once",
    })
    execute?: boolean,
  ) {
    const op = "mcp set";
    const nextAudience = parseChoice<McpAudience>(op, "--audience", audience, MCP_AUDIENCES, asJson);
    const nextUploads = parseChoice(op, "--uploads", uploads, ["on", "off"] as const, asJson);
    const nextProtocol = parseChoice<McpProtocolMode>(op, "--protocol", protocol, MCP_PROTOCOL_MODES, asJson);
    if (!nextAudience && !nextUploads && !nextProtocol) {
      usage(op, "Give at least one of --audience, --uploads or --protocol.", {
        asJson,
        acceptedValues: ["--audience", "--uploads", "--protocol"],
      });
    }
    if (nextUploads === "on" && !agent?.trim()) {
      usage(op, "--uploads on applies to one agent: add --agent <id>.", { asJson });
    }
    const server = requireServer(op, name, asJson);
    const agentId = agent?.trim() || undefined;
    let targets: McpAgentServerRecord[] = [];
    if (agentId) {
      const attachment = getMcpAttachment(agentId, server.name);
      if (!attachment) {
        failMcp(
          op,
          "NOT_ATTACHED",
          `MCP server ${server.name} is not attached to ${JSON.stringify(agentId.slice(0, 64))}.`,
          {
            asJson,
            suggestedAction: `Attach it first: ravi mcp attach ${server.name} <agent> --execute`,
          },
        );
      }
      targets = [attachment];
    } else {
      targets = listMcpAttachments({ server: server.name });
    }
    if ((nextAudience || nextUploads) && targets.length === 0) {
      failMcp(op, "NOT_ATTACHED", `MCP server ${server.name} is not attached to any agent.`, { asJson });
    }
    if (nextUploads === "on" && server.transport !== "http") {
      failMcp(op, "UPLOADS_NOT_SUPPORTED", "File uploads exist only for http servers.", {
        asJson,
        exitCode: CONTRACT_EXIT_USAGE,
      });
    }
    if (nextUploads === "on") {
      for (const target of targets) refuseRemoteUploads(op, server, target.agentId, asJson);
    }
    const widenAudience = nextAudience === "any" && targets.some((item) => item.audience !== "any");
    const narrowAudience = nextAudience === "operator" && targets.some((item) => item.audience !== "operator");
    const widenUploads = nextUploads === "on" && targets.some((item) => !item.uploads);
    const narrowUploads = nextUploads === "off" && targets.some((item) => item.uploads);
    const protocolChange = nextProtocol !== undefined && nextProtocol !== server.protocol;
    const widens = widenAudience || widenUploads || protocolChange;

    if (widenAudience) {
      // The row as it will be after this command: a protocol change forgets the probed era.
      const projected = {
        authKind: server.authKind,
        urlSecret: server.urlSecret,
        envKeys: server.envKeys,
        protocol: nextProtocol ?? server.protocol,
        era: protocolChange ? null : server.era,
      };
      if (isLegacyCredentialedMcpServer(projected)) {
        failMcp(
          op,
          "AUDIENCE_LEGACY",
          `MCP server ${server.name} uses the operator's credential (a login, a token in its URL, or stored env values) and is, or may be, on the legacy protocol, where a server may let the model confirm its own writes; it stays operator-only.`,
          {
            asJson,
            exitCode: CONTRACT_EXIT_POLICY,
            suggestedAction: `Pin the modern protocol first (ravi mcp set ${server.name} --protocol 2026-07-28 --execute) and let the daemon probe it`,
          },
        );
      }
    }
    if (widens) {
      requireOperatorTurn(op, "widen access to an MCP server", asJson);
      if (execute !== true) {
        contractDryRun(
          op,
          {
            server: server.name,
            agents: targets.map((item) => item.agentId),
            ...(nextAudience ? { audience: nextAudience } : {}),
            ...(nextUploads ? { uploads: nextUploads } : {}),
            ...(protocolChange ? { protocol: { from: server.protocol, to: nextProtocol } } : {}),
          },
          { asJson },
        );
      }
    }

    const changed = widens || narrowAudience || narrowUploads;
    try {
      if (protocolChange) updateMcpServerConfig(server.name, { protocol: nextProtocol });
      if (nextAudience || nextUploads) {
        updateMcpAttachments({
          server: server.name,
          ...(agentId ? { agentId } : {}),
          ...(nextAudience ? { audience: nextAudience } : {}),
          ...(nextUploads ? { uploads: nextUploads === "on" } : {}),
        });
      }
    } catch (error) {
      failFromError(op, error, asJson);
    }
    const after = requireServer(op, server.name, asJson);
    const attachments = listMcpAttachments({ server: server.name });
    const payload = {
      server: serverSummary(after, attachments),
      changed,
      protocol: protocolChange ? { from: server.protocol, to: after.protocol } : null,
      attachments: (agentId ? attachments.filter((item) => item.agentId === agentId) : attachments).map(attachmentView),
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(changed ? `Updated ${server.name}` : `${server.name} already had that setting`);
    printSummary(payload.server);
    return payload;
  }

  @Command({ name: "enable", description: "Enable a disabled MCP server; dry-run unless --execute" })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "enable",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(enabledReturnSchema)
  enable(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually enable; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp enable";
    const server = requireServer(op, name, asJson);
    requireOperatorTurn(op, "enable an MCP server", asJson);
    if (server.transport === "stdio") requireSuperadmin(op, "enable", asJson);
    if (server.enabled) return this.printEnabled(server, false, asJson);
    if (execute !== true) {
      contractDryRun(
        op,
        {
          server: server.name,
          transport: server.transport,
          agents: listMcpAttachments({ server: server.name }).map((item) => item.agentId),
        },
        { asJson },
      );
    }
    let updated: McpServerRecord | null = null;
    try {
      updated = updateMcpServerConfig(server.name, { enabled: true });
    } catch (error) {
      failFromError(op, error, asJson);
    }
    return this.printEnabled(updated ?? requireServer(op, server.name, asJson), true, asJson);
  }

  @Command({ name: "disable", description: "Disable an MCP server for every agent (applies at once)" })
  @CommandAccess({ kind: "mutate", resource: "mcp.servers", action: "disable", risk: "medium" })
  @Returns(enabledReturnSchema)
  disable(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp disable";
    const server = requireServer(op, name, asJson);
    if (!server.enabled) return this.printEnabled(server, false, asJson);
    let updated: McpServerRecord | null = null;
    try {
      updated = updateMcpServerConfig(server.name, { enabled: false });
    } catch (error) {
      failFromError(op, error, asJson);
    }
    return this.printEnabled(updated ?? requireServer(op, server.name, asJson), true, asJson);
  }

  private printEnabled(server: McpServerRecord, changed: boolean, asJson?: boolean) {
    const payload = { server: serverSummary(server), changed };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    const state = server.enabled ? "enabled" : "disabled";
    console.log(changed ? `MCP server ${server.name} ${state}` : `MCP server ${server.name} was already ${state}`);
    return payload;
  }

  @Command({
    name: "remove",
    description: "Remove an MCP server, its attachments and its stored secrets (applies at once)",
  })
  @CommandAccess({ kind: "mutate", resource: "mcp.servers", action: "remove", risk: "medium" })
  @Returns(removeReturnSchema)
  async remove(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp remove";
    const server = requireServer(op, name, asJson);
    const attachments = listMcpAttachments({ server: server.name });
    // The registration goes first: from then on no agent reaches the server,
    // whatever happens to the secret.
    let removed: McpServerRecord | null = null;
    try {
      removed = removeMcpServer(server.name);
    } catch (error) {
      failFromError(op, error, asJson);
    }
    if (!removed) requireServer(op, server.name, asJson);
    // Its open background calls end: the follower discards their results (no content is delivered).
    let callsCancelled = 0;
    try {
      callsCancelled = requestMcpCallsCancelForServer(server.name);
      clearMcpServerRateLimit(server.name);
    } catch {
      // no-cause: the follower discards the calls of a removed server on its next look either way.
      callsCancelled = 0;
    }
    // And its remote skill pins, for every agent (the plugin is rebuilt without their stubs).
    const skillPinsDropped = (await mcpSkills()).dropMcpSkillPinsForServer(server.name);
    let secretDeleted = false;
    let secretError = false;
    try {
      // Under the credential lock, so a token refresh in flight cannot write the login back after it.
      const { withMcpCredentialLock } = await import("../../mcp/oauth-provider.js");
      secretDeleted = await withMcpCredentialLock(server.name, () => deleteMcpServerSecret(server.name));
    } catch {
      // no-cause: the server is already unregistered; the secret's state is reported, never the backend error.
      secretError = true;
    }
    const payload = {
      removed: serverSummary(removed ?? server, attachments),
      detachedAgents: attachments.map((item) => item.agentId),
      callsCancelled,
      skillPinsDropped,
      secretDeleted,
      secretDeleteFailed: secretError,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(`Removed MCP server ${server.name}`);
    if (payload.detachedAgents.length) console.log(`Detached from: ${payload.detachedAgents.join(", ")}`);
    if (callsCancelled) console.log(`Background calls ended (results discarded): ${callsCancelled}`);
    if (skillPinsDropped) console.log(`Remote skill pins dropped: ${skillPinsDropped}`);
    if (secretError) {
      console.log(
        `Its stored secret could not be deleted; remove it with: ravi credentials connections remove --provider mcp --connection ${server.name} --delete-secret --execute`,
      );
    }
    return payload;
  }

  @Command({
    name: "tools",
    description: "List the MCP tools this turn may call (all attached servers, or one)",
    helpAfter: `
RULES
  Lists what the current turn may call: the agent's attached servers that pass
  for this turn (audience, enabled, login) and, on each, the tools it is
  granted (use tool:mcp__<server>__<tool>). Reads the catalog the daemon cached;
  connects to nothing. Runs in the Ravi daemon: from a terminal it needs a
  running daemon and a context credential.
  Servers the turn may not use are listed under "unavailable" with the reason.
  One answer lists at most 100 tools and 96 KB of entries, servers taking
  turns; what was left out is counted under "omitted" with a note: list one
  server, or narrow with --query.

EXAMPLES
  ravi mcp tools --json
  ravi mcp tools docs --query search --json`,
  })
  @CommandAccess({ kind: "read", resource: "mcp.tools", action: "list", risk: "low" })
  @Scope("open")
  @Returns(toolsReturnSchema)
  async tools(
    @Arg("server", { required: false, description: "Only this server" }) server?: string,
    @Option({ flags: "--query <text>", description: "Only tools whose name or description holds this text" })
    query?: string,
    @Option({ flags: "--agent <id>", description: "The agent, only when the context belongs to none" })
    agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp tools";
    const serverName = server?.trim() || undefined;
    const queryText = query?.trim() || undefined;
    if (queryText && queryText.length > MCP_TOOLS_QUERY_MAX) {
      usage(op, `--query holds at most ${MCP_TOOLS_QUERY_MAX} characters.`, { asJson });
    }
    if (serverName !== undefined && serverName.length > 64) usage(op, "The server name is too long.", { asJson });
    let payload: ToolsPayload;
    if (!runsInDaemon()) {
      const forwarded = await forwardToDaemon(
        op,
        "tools",
        {
          ...(serverName ? { server: serverName } : {}),
          ...(queryText ? { query: queryText } : {}),
          ...(agent?.trim() ? { agent: agent.trim() } : {}),
        },
        asJson,
      );
      const parsed = toolsReturnSchema.safeParse(forwarded);
      if (!parsed.success) {
        failMcp(
          op,
          "GATEWAY_RESPONSE_INVALID",
          "The Ravi daemon answered the MCP tool listing in an unexpected shape.",
          {
            asJson,
          },
        );
      }
      payload = parsed.data;
    } else {
      const scope = resolveMcpTurnScope(op, agent, asJson);
      const listed = listMcpToolsForTurn({
        context: scope.context,
        agentId: scope.agentId,
        ...(serverName ? { server: serverName } : {}),
        ...(queryText ? { query: queryText } : {}),
      });
      if (serverName && listed.unavailable.length) {
        // One named server that the turn may not list: say why, with the denial's exit code.
        const denial = listed.unavailable[0]!;
        const exit = mcpDenialExit(denial.code);
        failMcp(op, exit.code, denial.reason, {
          asJson,
          exitCode: exit.exitCode,
          ...(denial.code === "needs_login" ? { suggestedAction: mcpLoginHint(denial.server) } : {}),
          ...(denial.code === "not_registered"
            ? {
                suggestions: suggestSimilar(
                  serverName,
                  listMcpAttachments({ agentId: scope.agentId }).map((item) => item.server),
                ),
              }
            : {}),
        });
      }
      payload = {
        agentId: scope.agentId,
        server: serverName ?? null,
        query: queryText ?? null,
        total: listed.total,
        tools: listed.tools as ToolsPayload["tools"],
        omitted: listed.omitted,
        note: listed.note,
        unavailable: listed.unavailable,
      };
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printTools(payload);
    return payload;
  }

  @Command({
    name: "call",
    description: "Call one tool of a registered MCP server for this turn; dry-run unless --execute",
    remoteTimeoutMs: MCP_CALL_REMOTE_TIMEOUT_MS,
    helpAfter: `
RULES
  Calls one tool the current turn may call (see ravi mcp tools). The tool is its
  remote name or its full name mcp__<server>__<tool>; --input is a JSON object of
  arguments. Without --execute it prints the plan (server, tool and argument
  keys, never values) and exits 3. The daemon checks the call again (attached,
  enabled, audience, use tool:mcp__<server>__<tool>, login) before it connects.
  --wait (seconds, default 45, at most 110; 55 as a runtime tool) bounds the
  wait. A call that is still running then, or that the server runs as a task,
  continues in the background (outcome detached, with a callId): its result
  arrives in this session as a new message, once. Do not call the tool again
  for it; ravi mcp calls cancel <id> asks the server to stop it (the server
  decides whether its work stops). Without a session to deliver
  to, past --wait the outcome on the server is unknown and it is not sent again.
  A tool error is a result (outcome tool_error), not a failed command.
  Runs in the Ravi daemon: from a terminal it needs a running daemon and a
  context credential.

EXAMPLES
  ravi mcp call docs search --input '{"query":"rate limits"}' --execute --json
  ravi mcp call docs mcp__docs__search --input '{"query":"rate limits"}' --wait 90 --execute`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.tools",
    action: "call",
    risk: "high",
    requiresConfirmation: true,
    redactions: ["input"],
  })
  @Scope("open")
  @Returns(callReturnSchema)
  async call(
    @Arg("server", { description: "Server name" }) server: string,
    @Arg("tool", { description: "Tool name (remote name, or mcp__<server>__<tool>)" }) tool: string,
    @Option({ flags: "--input <json>", description: "Tool arguments as one JSON object (default {})" })
    input?: string,
    @Option({ flags: "--wait <s>", description: "Seconds to wait for the result (default 45, at most 110)" })
    wait?: string,
    @Option({ flags: "--agent <id>", description: "The agent, only when the context belongs to none" })
    agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually call the tool; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp call";
    const serverName = typeof server === "string" ? server.trim() : "";
    const rawTool = typeof tool === "string" ? tool.trim() : "";
    if (!serverName || serverName.length > 64) usage(op, "Give the server name.", { asJson });
    if (!rawTool || rawTool.length > 200) usage(op, "Give the tool name.", { asJson });
    const toolName = remoteMcpToolName(serverName, rawTool);
    const parsedInput = parseMcpCallInput(input);
    if (!parsedInput.ok) usage(op, parsedInput.reason, { asJson });
    const transport = getContext({ localOnly: true })?.transport;
    const parsedWait = parseMcpCallWait(wait, transport === "tool");
    if (!parsedWait.ok) usage(op, parsedWait.reason, { asJson });

    let payload: McpCliCallResult;
    if (!runsInDaemon()) {
      const forwarded = await forwardToDaemon(
        op,
        "call",
        {
          server: serverName,
          tool: rawTool,
          ...(input !== undefined ? { input } : {}),
          ...(wait !== undefined ? { wait: String(wait) } : {}),
          ...(agent?.trim() ? { agent: agent.trim() } : {}),
          ...(execute === true ? { execute: true } : {}),
        },
        asJson,
        MCP_CALL_REMOTE_TIMEOUT_MS,
      );
      const parsed = callReturnSchema.safeParse(forwarded);
      if (!parsed.success) {
        failMcp(op, "GATEWAY_RESPONSE_INVALID", "The Ravi daemon answered the MCP call in an unexpected shape.", {
          asJson,
        });
      }
      payload = parsed.data as McpCliCallResult;
    } else {
      const scope = resolveMcpTurnScope(op, agent, asJson);
      // Every check that can refuse runs before the brake, so a dry run shows only a call --execute can make.
      const decision = authorizeMcpUse({
        context: scope.context,
        agentId: scope.agentId,
        server: serverName,
        tool: toolName,
        surface: "call",
      });
      if (!decision.allowed) {
        const exit = mcpDenialExit(decision.code);
        failMcp(op, exit.code, decision.reason, {
          asJson,
          exitCode: exit.exitCode,
          ...(decision.code === "needs_login"
            ? { suggestedAction: mcpLoginHint(serverName) }
            : { suggestedAction: "List what this turn may call with: ravi mcp tools --json" }),
        });
      }
      const exposedName = `mcp__${decision.server.name}__${toolName}`;
      if (execute !== true) {
        const keys = mcpArgumentKeys(parsedInput.value);
        contractDryRun(
          op,
          {
            server: decision.server.name,
            tool: toolName,
            name: exposedName,
            argumentKeys: keys.keys,
            ...(keys.more ? { moreArgumentKeys: keys.more } : {}),
            waitSeconds: parsedWait.seconds,
            connects: false,
          },
          { asJson },
        );
      }
      const { getMcpGateway } = await import("../../mcp/gateway.js");
      const gateway = getMcpGateway();
      if (!gateway) {
        failMcp(
          op,
          "MCP_GATEWAY_UNAVAILABLE",
          "The Ravi MCP gateway is not running in this daemon; nothing was sent.",
          {
            asJson,
            suggestedAction: "Check the daemon (ravi daemon status) and retry",
            details: { retryable: true },
          },
        );
      }
      const result = await gateway.call(
        { context: scope.context, agentId: scope.agentId },
        {
          server: decision.server.name,
          tool: toolName,
          arguments: parsedInput.value,
          surface: "cli",
          budgetMs: parsedWait.seconds * 1000,
          // Past the wait (or on a task result) the call continues in the background and its result
          // arrives in the turn's session (spec mcp, Background Calls And Tasks).
          detach: true,
        },
      );
      if (!result.ok) {
        const exit = mcpCallFailureExit(result);
        failMcp(op, exit.code, result.reason, {
          asJson,
          exitCode: exit.exitCode,
          ...(result.outcome === "needs_login"
            ? { suggestedAction: mcpLoginHint(serverName) }
            : result.outcome === "timeout" || result.outcome === "cancelled"
              ? { suggestedAction: "Do not call it again blindly: the outcome on the server is unknown" }
              : {}),
        });
      }
      payload = projectMcpCallResult(result, {
        server: decision.server.name,
        tool: toolName,
        name: exposedName,
        waitSeconds: parsedWait.seconds,
      });
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printCall(payload);
    return payload;
  }

  @Command({
    name: "login",
    description:
      "Sign in to an MCP server (OAuth in the browser, or a bearer token from stdin); dry-run unless --execute",
    helpAfter: `
RULES
  Only the operator logs in, from a terminal on the host, outside a session turn.
  OAuth servers: Ravi prints the authorization URL (only on a terminal: it holds
  the server's secret address, so never paste it into a chat or a ticket) and
  opens the browser, then waits for the redirect on http://127.0.0.1:${MCP_LOGIN_DEFAULT_PORT}/callback (--port picks another port;
  a changed redirect registers the client again). With --paste nothing listens:
  paste the URL the browser ended on. The client registers dynamically, uses the
  client metadata document named by RAVI_MCP_CLIENT_METADATA_URL when that is set,
  or the id given with --client-id.
  Bearer servers: the token is read from stdin with --token-stdin.
  The login is stored in the credentials store only after the server accepted
  it; tokens are never printed. A stored OAuth login it replaces is revoked on
  the server, best effort. The daemon reconnects on its own afterwards.

EXAMPLES
  ravi mcp login console --execute
  ravi mcp login console --paste --execute
  ravi mcp login search --token-stdin --execute < token.txt`,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "login",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(loginReturnSchema)
  async login(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--client-id <id>", description: "OAuth client id registered by hand with the server" })
    clientId?: string,
    @Option({
      flags: "--port <n>",
      description: `Loopback port of the OAuth redirect (default ${MCP_LOGIN_DEFAULT_PORT})`,
    })
    port?: string,
    @Option({ flags: "--token-stdin", description: "Read the bearer token of a bearer server from stdin" })
    tokenStdin?: boolean,
    @Option({ flags: "--paste", description: "Paste the redirect URL instead of listening on the loopback port" })
    paste?: boolean,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually sign in; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp login";
    // The operator's browser and terminal: never from a session turn or through the gateway.
    const transport = getContext({ localOnly: true })?.transport;
    if (
      requiresRemoteGateway(process.env) ||
      carriesRaviRuntimeEnvMarker(process.env) ||
      transport === "gateway" ||
      transport === "tool"
    ) {
      const error = cliOnlyCommandError(op);
      failMcp(op, error.code, error.message, {
        asJson,
        exitCode: error.exitCode,
        suggestedAction: "Run it from a terminal on the host, outside a session turn.",
      });
    }
    const server = requireServer(op, name, asJson);
    const method = server.transport === "http" ? mcpLoginMethod(server.authKind) : null;
    if (server.transport !== "http") {
      usage(op, `MCP server ${server.name} is a stdio server; it has no login.`, { asJson });
    }
    if (!method) {
      usage(op, `MCP server ${server.name} is registered with auth none; it needs no login.`, { asJson });
    }
    const clientIdValue = clientId?.trim() || undefined;
    if (clientId !== undefined && (!clientIdValue || clientIdValue.length > 512 || /\s/.test(clientIdValue))) {
      usage(op, "--client-id must be one word of at most 512 characters.", { asJson });
    }
    const portValue = parsePort(op, port, asJson);
    if (method === "bearer") {
      if (tokenStdin !== true) {
        usage(op, `MCP server ${server.name} reads its token from stdin: pass --token-stdin.`, {
          asJson,
          suggestedAction: `ravi mcp login ${server.name} --token-stdin --execute < token.txt`,
        });
      }
      if (clientIdValue || paste || portValue !== undefined) {
        usage(op, "--client-id, --port and --paste are for OAuth servers only.", { asJson });
      }
    } else if (tokenStdin === true) {
      usage(op, `MCP server ${server.name} uses OAuth: sign in through the browser instead of --token-stdin.`, {
        asJson,
      });
    }
    let clientMetadataUrl: string | undefined;
    if (method === "oauth" && !clientIdValue) {
      try {
        clientMetadataUrl = mcpClientMetadataUrl();
      } catch (error) {
        failLogin(op, error, asJson);
      }
    }
    if (tokenStdin === true) assertStdinAvailable(op, "--token-stdin", asJson);
    // The token is read and checked before the brake, so the dry run shows only a plan --execute can carry out.
    let bearerToken: string | undefined;
    if (method === "bearer") {
      try {
        bearerToken = checkMcpBearerToken(await readStdin(op, asJson));
      } catch (error) {
        failLogin(op, error, asJson);
      }
    }
    requireOperatorTurn(op, "sign in to MCP servers", asJson);

    const redirectUri = method === "oauth" ? mcpLoginRedirectUrl(portValue ?? MCP_LOGIN_DEFAULT_PORT) : null;
    if (execute !== true) {
      if (!asJson) {
        console.log(`Would sign in to MCP server ${server.name} (${where(serverSummary(server))}, auth ${method})`);
        if (redirectUri) console.log(`  redirect: ${redirectUri}${paste ? " (pasted, nothing listens)" : ""}`);
      }
      contractDryRun(
        op,
        {
          server: server.name,
          authKind: method,
          redirectUri,
          listens: method === "oauth" && !paste,
          opensBrowser: method === "oauth" && !paste,
          clientRegistration:
            method !== "oauth"
              ? null
              : clientIdValue
                ? "preregistered"
                : clientMetadataUrl
                  ? "metadata_document"
                  : "dynamic",
          readsStdin: method === "bearer",
          tokenReceived: bearerToken !== undefined,
          connects: false,
        },
        { asJson },
      );
    }

    const deps: McpLoginDeps = loginDepsForTests ?? {
      readPastedUrl: readPastedLine,
    };
    let result: McpLoginResult;
    try {
      // The MCP client loads only when a login actually runs.
      const { runMcpLogin } = await import("../../mcp/login.js");
      result = await runMcpLogin(
        {
          server,
          ...(clientIdValue ? { clientId: clientIdValue } : {}),
          ...(portValue !== undefined ? { port: portValue } : {}),
          ...(paste ? { paste: true } : {}),
          ...(bearerToken !== undefined ? { bearerToken } : {}),
          ...(clientMetadataUrl ? { clientMetadataUrl } : {}),
        },
        deps,
      );
    } catch (error) {
      failLogin(op, error, asJson);
    }
    if (asJson) {
      printJson(result);
      return result;
    }
    console.log(`Signed in to MCP server ${result.server} (${result.era}, ${result.toolCount} tools)`);
    if (result.scopes.length) console.log(`  scopes: ${result.scopes.join(" ")}`);
    if (result.previousGrant) console.log(`  previous login: ${revocationText(result.previousGrant)}`);
    console.log("  The daemon reconnects with the new login on its own.");
    return result;
  }

  @Command({
    name: "logout",
    description:
      "Forget the stored login of an MCP server, revoking an OAuth grant on its server first (applies at once)",
  })
  @CommandAccess({ kind: "mutate", resource: "mcp.servers", action: "logout", risk: "medium" })
  @Returns(logoutReturnSchema)
  async logout(
    @Arg("name", { description: "Server name" }) name: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp logout";
    const server = requireServer(op, name, asJson);
    let removed = false;
    let revocation: "revoked" | "not_confirmed" | "not_offered" = "not_offered";
    try {
      const { runMcpLogout } = await import("../../mcp/login.js");
      const result = await runMcpLogout(server, loginDepsForTests ?? {});
      removed = result.removed;
      revocation = result.revocation;
    } catch (error) {
      failLogin(op, error, asJson);
    }
    const payload = {
      server: server.name,
      removed,
      revocation,
      status: getMcpServer(server.name)?.status ?? server.status,
    };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      removed ? `Forgot the login of MCP server ${server.name}` : `MCP server ${server.name} has no stored login`,
    );
    if (revocation !== "not_offered") console.log(`  server-side: ${revocationText(revocation)}`);
    return payload;
  }

  @Command({
    name: "import",
    description: "Register the MCP servers runtimes loaded from their own configuration; dry-run unless --execute",
    helpAfter: `
SOURCES (read only, never changed)
  <agent cwd>/.mcp.json, ~/.claude.json (user and project entries), the .mcp.json
  and plugin.json of each plugin under ~/ravi/plugins, $CODEX_HOME/config.toml
  (default ~/.codex) and <agent cwd>/.codex/config.toml.

RULES
  Only the operator imports, from their terminal. Each server is registered with
  audience operator and origin import:<path> and attached only to the agents
  whose runtime loaded it: Claude Code files to Claude agents (per their
  settingSources, minus servers Claude Code has disabled), Codex files to Codex
  agents. An entry no agent loaded is skipped with the reason; --agent narrows.
  Names are normalized (lower case, underscores become hyphens); entries that
  end up with one name and different settings need --as <native>=<name>, or
  --as <source kind>:<native>=<name> when two sources use the same native name
  (kinds: agent-mcp-json, claude-user, claude-project, plugin, codex-home,
  codex-project).
  The full URL and env values move to the credentials store; the plan names
  them, never their values. stdio servers need admin on system:*.
  Grants are not changed. An agent sees an imported server's tools only with
  use:tool:mcp__<name>__* (or a grant per tool) under the registered name; the
  plan names each agent the server reaches that lacks it, with the exact
  command that grants it (agents on the default profile already hold it).

EXAMPLES
  ravi mcp import
  ravi mcp import --as github_tools=github --skip scratch --execute
  ravi mcp import --as codex-home:search=search-codex --execute`,
  })
  @CliOnly()
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.servers",
    action: "import",
    risk: "high",
    requiresConfirmation: true,
  })
  @Returns(importReturnSchema)
  async importServers(
    @Option({ flags: "--agent <id...>", description: "Only for these agents (repeatable); default every local agent" })
    agents?: string[],
    @Option({
      flags: "--as <old=new...>",
      description: "Register a native entry under another name; old is a native name or <source kind>:<native name>",
    })
    renames?: string[],
    @Option({
      flags: "--skip <name...>",
      description: "Leave out native entries: a native name or <source kind>:<native name> (repeatable)",
    })
    skip?: string[],
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually register and attach; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp import";
    // Host paths and host secrets: only the operator's own terminal, never a session turn.
    const transport = getContext({ localOnly: true })?.transport;
    if (
      requiresRemoteGateway(process.env) ||
      carriesRaviRuntimeEnvMarker(process.env) ||
      transport === "gateway" ||
      transport === "tool"
    ) {
      const error = cliOnlyCommandError(op);
      failMcp(op, error.code, error.message, {
        asJson,
        exitCode: error.exitCode,
        suggestedAction: "Run it from a terminal on the host, outside a session turn.",
      });
    }
    const renameMap = parseRenames(op, asList(renames), asJson);
    const skipSet = new Set(asList(skip));
    const selected = asList(agents).length
      ? [...new Set(asList(agents))].map((id) => dbGetAgent(requireAgent(op, id, asJson))!)
      : dbListAgents().filter((agent) => !agent.remote);

    const host = importHost();
    const discovery = discoverNativeMcpEntries({
      agents: mcpImportAgentsOf(selected),
      homeDir: host.homeDir,
      codexHome: host.codexHome,
      ...(host.pluginDirs ? { pluginDirs: host.pluginDirs } : {}),
      fs: host.fs,
    });
    const nativeNames = new Set(discovery.entries.flatMap((entry) => [entry.nativeName, mcpImportEntryKey(entry)]));
    for (const name of [...renameMap.keys(), ...skipSet]) {
      if (!nativeNames.has(name)) {
        usage(op, `No native MCP entry is named ${JSON.stringify(name.slice(0, 64))}.`, {
          asJson,
          suggestions: suggestSimilar(name, [...nativeNames]),
        });
      }
    }

    const attached = new Map<string, Set<string>>();
    for (const attachment of listMcpAttachments()) {
      attached.set(attachment.server, (attached.get(attachment.server) ?? new Set()).add(attachment.agentId));
    }
    const plan = planMcpImport({
      entries: discovery.entries,
      renames: renameMap,
      skip: skipSet,
      registered: await loadRegisteredForImport(),
      attached,
    });
    const base = importPayload(plan, discovery.sources);

    if (plan.conflicts.length) {
      const first = plan.conflicts[0]!;
      failMcp(
        op,
        "IMPORT_CONFLICT",
        plan.conflicts.length === 1
          ? first.message
          : `${plan.conflicts.length} entries need a decision. ${first.message}`,
        {
          asJson,
          exitCode: CONTRACT_EXIT_USAGE,
          suggestedAction: "Give each conflicting entry a name with --as <native>=<name>, or leave it out with --skip",
          details: {
            issues: plan.conflicts.map((conflict) => ({
              path: [conflict.name ?? conflict.from[0]?.nativeName ?? "entry"],
              code: conflict.code,
              message: conflict.message,
              entries: conflict.from.map((entry) => entry.nativeName),
            })),
          },
        },
      );
    }
    for (const server of plan.servers) {
      for (const agentId of server.attach) refuseRemoteStdio(op, server, agentId, asJson);
    }

    const changes = plan.servers.filter((server) => server.action !== "unchanged");
    if (changes.length === 0) {
      const payload = { executed: false, changed: false, ...base };
      if (asJson) printJson(payload);
      else {
        printImport(payload);
        console.log("Nothing to import.");
      }
      return payload;
    }
    const createdBy = requireOperatorTurn(op, "import MCP servers", asJson);
    if (changes.some((server) => server.transport === "stdio")) requireSuperadmin(op, "import", asJson);

    if (execute !== true) {
      if (!asJson) printImport({ executed: false, changed: false, ...base });
      contractDryRun(
        op,
        {
          servers: base.servers
            .filter((server) => server.action !== "unchanged")
            .map((server) => ({
              name: server.name,
              action: server.action,
              transport: server.transport,
              urlDisplay: server.urlDisplay,
              command: server.command,
              args: server.args,
              envKeys: server.envKeys,
              agents: server.attach,
              audience: "operator",
              origin: server.origin,
              grant: server.grant,
              moves: server.moves,
            })),
          unsupported: base.unsupported.length,
          sourcesTouched: false,
          connects: false,
        },
        { asJson },
      );
    }

    const done: string[] = [];
    for (const server of changes) {
      try {
        if (server.action === "register") {
          const secret = plan.secrets.get(server.name);
          if (!secret) throw new McpRegistryError("write_failed", `No secret document was planned for ${server.name}.`);
          // Row first (the atomic claim on the name), then the secret: see storeSecretForNewServer.
          if (server.transport === "http") {
            createMcpServer({
              name: server.name,
              transport: "http",
              url: secret.url as string,
              origin: server.origin,
              enabled: server.enabled,
              createdBy,
            });
          } else {
            createMcpServer({
              name: server.name,
              transport: "stdio",
              command: server.command as string,
              args: server.args,
              envKeys: server.envKeys,
              origin: server.origin,
              enabled: server.enabled,
              createdBy,
            });
          }
          await storeSecretForNewServer(server.name, secret);
        }
        for (const agentId of server.attach) {
          attachMcpServer({ agentId, server: server.name, audience: "operator", createdBy });
        }
        done.push(server.name);
      } catch (error) {
        if (done.length && !asJson) console.log(`Imported before the failure: ${done.join(", ")}`);
        failFromError(op, error, asJson);
      }
    }
    const payload = { executed: true, changed: true, ...base };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printImport(payload);
    console.log(
      `Imported ${done.length} MCP server${done.length === 1 ? "" : "s"}; the source files were not changed.`,
    );
    return payload;
  }
}

// ============================================================================
// Background calls
// ============================================================================

type McpCallView = z.infer<typeof mcpCallViewSchema>;

/** A call as the CLI shows it: never its result, its arguments or its origin person. */
function mcpCallView(call: McpCallRecord): McpCallView {
  return {
    id: call.id,
    server: call.server,
    tool: call.tool,
    agentId: call.agentId,
    sessionName: call.sessionName,
    state: call.state,
    outcome: call.outcome,
    detachReason: call.detachReason,
    taskStatus: call.taskStatus,
    cancelRequestedAt: call.cancelRequestedAt,
    lastError: call.lastError,
    createdAt: call.createdAt,
    updatedAt: call.updatedAt,
    expiresAt: call.expiresAt,
    deliveredAt: call.deliveredAt,
  };
}

/** The automation principal of a call's delivery turn: `automation:mcp-call:<id>`. */
const MCP_CALL_DELIVERY_PRINCIPAL = "automation:mcp-call:";

export type McpCallsVisibility =
  | { scope: "all" }
  | {
      scope: "session";
      agentId: string;
      sessionName: string;
      /** The call whose outcome this turn delivers, which it always sees (the delivery turn only). */
      ownCallId: string | null;
      /** Whether this turn may use that server's tool: the same authorization as making the call. */
      mayUse: (server: string, tool: string) => boolean;
    };

/**
 * Which calls this turn may see and cancel (spec mcp, Management CLI). It
 * runs where the command runs: in the daemon for a turn's CLI, which forwards
 * every command to the daemon's gateway with its context key.
 *
 * The operator's own turn (and the terminal) sees every call. Any other turn
 * sees only calls of its own agent and session whose server and tool that
 * turn may use: `authorizeMcpUse` for that tool (registered, enabled,
 * attached, audience, `use tool:mcp__<server>__<tool>`; a server that only
 * needs a login again still counts), so a contact's turn in a shared session
 * never sees or cancels a call to an operator-only server. The delivery turn
 * of a call (principal `automation:mcp-call:<id>`) also sees that one call.
 * A turn with no agent or no session is refused (exit 3). A classifier that
 * throws refuses too.
 */
export function mcpCallsVisibility(
  op: string,
  asJson: boolean | undefined,
  deps: {
    operatorOwnTurn?: () => boolean;
    context?: () => ContextRecord | null;
    authorize?: AuthorizeMcpUseDeps;
  } = {},
): McpCallsVisibility {
  let own = false;
  try {
    own = (deps.operatorOwnTurn ?? (() => isOperatorOwnTurn()))();
  } catch {
    // no-cause: a turn that cannot be classified is not the operator's own; the session rule below applies.
    own = false;
  }
  if (own) return { scope: "all" };
  const context = deps.context ? deps.context() : (getContext()?.context ?? null);
  const agentId = context?.agentId?.trim();
  const sessionName = context?.sessionName?.trim();
  if (context && agentId && sessionName) {
    const principal = typeof context.metadata?.actorPrincipal === "string" ? context.metadata.actorPrincipal : "";
    const deliveredId = principal.startsWith(MCP_CALL_DELIVERY_PRINCIPAL)
      ? principal.slice(MCP_CALL_DELIVERY_PRINCIPAL.length)
      : "";
    const decisions = new Map<string, boolean>();
    const mayUse = (server: string, tool: string): boolean => {
      const key = `${server}\0${tool}`;
      const known = decisions.get(key);
      if (known !== undefined) return known;
      const decision = authorizeMcpUse({ context, agentId, server, tool, surface: "list" }, deps.authorize);
      const allowed = decision.allowed || decision.code === "needs_login";
      decisions.set(key, allowed);
      return allowed;
    };
    return {
      scope: "session",
      agentId,
      sessionName,
      ownCallId: MCP_CALL_ID_PATTERN.test(deliveredId) ? deliveredId : null,
      mayUse,
    };
  }
  failMcp(
    op,
    "OPERATOR_TURN_REQUIRED",
    "Only the operator, or a turn of the session that started a call, can see it.",
    {
      asJson,
      exitCode: CONTRACT_EXIT_POLICY,
      suggestedAction: "Run it from the session that started the call, or from the operator's terminal",
    },
  );
}

/** Whether a call is one this turn may see and cancel. */
export function mcpCallVisibleTo(visible: McpCallsVisibility, call: McpCallRecord): boolean {
  if (visible.scope === "all") return true;
  if (call.agentId !== visible.agentId || call.sessionName !== visible.sessionName) return false;
  return call.id === visible.ownCallId || visible.mayUse(call.server, call.tool);
}

function parseCallStates(op: string, value: string | undefined, asJson?: boolean): McpCallState[] | undefined {
  if (!value) return undefined;
  if (value === "open") return [...MCP_CALL_OPEN_STATES];
  if ((MCP_CALL_STATES as readonly string[]).includes(value)) return [value as McpCallState];
  usage(op, `Unknown state ${JSON.stringify(value.slice(0, 32))}.`, {
    asJson,
    acceptedValues: ["open", ...MCP_CALL_STATES],
  });
}

function printCallView(call: McpCallView): void {
  const status = call.outcome ? `${call.state}/${call.outcome}` : call.state;
  const task = call.taskStatus ? ` task:${call.taskStatus}` : "";
  const cancel = call.cancelRequestedAt !== null ? " cancel-requested" : "";
  console.log(`${call.id}  ${call.server}/${call.tool}  ${status}${task}${cancel}  session ${call.sessionName}`);
  if (call.lastError) console.log(`  last error: ${call.lastError}`);
}

@Group({
  name: "mcp.calls",
  description: "Background MCP calls: list them and cancel one",
  scope: "open",
})
export class McpCallsCommands {
  @Command({
    name: "list",
    description: "List background MCP calls (the operator sees all; a session sees its own)",
    helpAfter: `
RULES
  A call leaves its turn when the server runs it as a task, or when it is
  still running at the end of its wait. Ravi follows it and delivers its
  outcome to the session that started it, once. This lists those calls:
  state (running, task, delivering, delivered, failed) and outcome. It never
  shows a result or the call's arguments.
  The operator's own turn and terminal see every call. Another turn sees only
  calls of its own session whose server and tool that turn may use (the same
  check as making the call), and the turn that delivers a call sees that call.

EXAMPLES
  ravi mcp calls list --state open --json
  ravi mcp calls list --server docs`,
  })
  @CommandAccess({ kind: "read", resource: "mcp.calls", action: "list", risk: "low" })
  @Returns(callsListReturnSchema)
  list(
    @Option({ flags: "--state <state>", description: "open, running, task, delivering, delivered or failed" })
    state?: string,
    @Option({ flags: "--server <name>", description: "Only calls of this server" }) server?: string,
    @Option({ flags: "--session <name>", description: "Only calls of this session (operator only)" })
    session?: string,
    @Option({ flags: "--limit <n>", description: "Page size", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset", defaultValue: "0" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp calls list";
    const states = parseCallStates(op, state?.trim() || undefined, asJson);
    const limitValue = Number.parseInt(limit ?? "50", 10);
    const offsetValue = Number.parseInt(offset ?? "0", 10);
    if (!Number.isFinite(limitValue) || limitValue < 1 || limitValue > 500) {
      usage(op, "--limit is a number from 1 to 500.", { asJson });
    }
    if (!Number.isFinite(offsetValue) || offsetValue < 0) usage(op, "--offset is a number from 0.", { asJson });
    const visible = mcpCallsVisibility(op, asJson);
    const filter: ListMcpCallsFilter = {
      ...(states ? { states } : {}),
      ...(server?.trim() ? { server: server.trim() } : {}),
    };
    if (visible.scope === "session") {
      filter.agentId = visible.agentId;
      filter.sessionName = visible.sessionName;
      filter.visible = {
        pairs: listMcpCallServerTools(filter).filter((pair) => visible.mayUse(pair.server, pair.tool)),
        ids: visible.ownCallId ? [visible.ownCallId] : [],
      };
    } else if (session?.trim()) {
      filter.sessionName = session.trim();
    }
    const total = countMcpCalls(filter);
    const calls = listMcpCalls({ ...filter, limit: limitValue, offset: offsetValue }).map(mcpCallView);
    const pagination = buildOffsetPagination({
      total,
      limit: limitValue,
      offset: offsetValue,
      returned: calls.length,
      nextCommand: (nextOffset: number) =>
        buildCommand([
          "ravi",
          "mcp",
          "calls",
          "list",
          state?.trim() && "--state",
          state?.trim(),
          server?.trim() && "--server",
          server?.trim(),
          visible.scope === "all" && session?.trim() && "--session",
          visible.scope === "all" && session?.trim(),
          "--limit",
          limitValue,
          "--offset",
          nextOffset,
        ]),
    });
    const payload = { scope: visible.scope, total, calls, pagination };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (!calls.length) console.log("No background MCP calls.");
    for (const call of calls) printCallView(call);
    if (pagination.nextCommand) console.log(`Next: ${pagination.nextCommand}`);
    return payload;
  }

  @Command({
    name: "cancel",
    description: "Cancel a background MCP call (applies at once)",
    helpAfter: `
RULES
  Asks Ravi to stop one background call. A task gets tasks/cancel, then Ravi
  reads it once more and delivers what the server says: the server decides
  whether its work stops. It may finish work it had already committed, or
  only stop reporting to Ravi while the work goes on (a cloud run keeps
  running; its server names the tool that stops it). A call still running
  inline is aborted; its outcome on the server is unknown. A call already
  finished is left as it is. The outcome arrives in the call's session as
  usual. A turn cancels only a call it may see (see ravi mcp calls list --help);
  any other call reads as not found.

EXAMPLES
  ravi mcp calls cancel mc_01jd8x00000000000000000000 --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "mcp.calls", action: "cancel", risk: "low" })
  @Returns(callsCancelReturnSchema)
  cancel(
    @Arg("id", { description: "Call id (mc_...)" }) id: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp calls cancel";
    const callId = typeof id === "string" ? id.trim() : "";
    if (!MCP_CALL_ID_PATTERN.test(callId)) usage(op, "Give a call id: mc_ followed by 26 characters.", { asJson });
    const visible = mcpCallsVisibility(op, asJson);
    const found = getMcpCall(callId);
    const allowed = found !== null && mcpCallVisibleTo(visible, found);
    if (!found || !allowed) {
      // A call this turn may not see (another session's, or a server or tool it may not use) is reported as
      // missing: its existence is not this turn's to know.
      failMcp(op, "MCP_CALL_NOT_FOUND", `No background MCP call ${callId} for this turn.`, {
        asJson,
        suggestedAction: "List the calls with ravi mcp calls list",
      });
    }
    const open = found.state === "running" || found.state === "task";
    const before = found.cancelRequestedAt;
    const after = open ? (requestMcpCallCancel(callId) ?? found) : found;
    const cancelRequested = open && before === null && after.cancelRequestedAt !== null;
    const payload = { call: mcpCallView(after), cancelRequested };
    if (asJson) {
      printJson(payload);
      return payload;
    }
    if (cancelRequested)
      console.log(`Cancel requested for ${callId}; its outcome arrives in session ${after.sessionName}.`);
    else if (open) console.log(`A cancel was already requested for ${callId}.`);
    else console.log(`${callId} has already finished (${after.state}${after.outcome ? `/${after.outcome}` : ""}).`);
    return payload;
  }
}

// ============================================================================
// Remote skills
// ============================================================================

const MCP_SKILLS_REMOTE_TIMEOUT_MS = 90_000;

const skillPinViewSchema = z
  .object({
    agent: z.string(),
    skill: z.string(),
    state: z.enum(["active", "stale"]),
    staleReason: z.enum(["manifest_changed", "digest_mismatch", "dynamic", "gone"]).nullable(),
    externalAllowed: z.boolean(),
  })
  .strict();

const skillStaleReasonSchema = z.enum(["manifest_changed", "digest_mismatch", "dynamic", "gone"]);

const skillsListReturnSchema = z
  .object({
    server: z.string(),
    agentId: z.string(),
    supported: z.boolean(),
    total: z.number(),
    pagination: z
      .object({
        limit: z.number(),
        offset: z.number(),
        returned: z.number(),
        total: z.number(),
        hasMore: z.boolean(),
        nextOffset: z.number().nullable(),
        nextCommand: z.string().nullable(),
      })
      .strict(),
    skills: z.array(
      z
        .object({
          uri: z.string(),
          id: z.string().nullable(),
          name: z.string(),
          description: z.string(),
          dynamic: z.boolean(),
          files: z.number().nullable(),
          bytes: z.number().nullable(),
          manifestDigest: z.string().nullable(),
          libraryRef: z.string().nullable(),
          pins: z.array(skillPinViewSchema),
        })
        .strict(),
    ),
    invalid: z.number(),
    stalePins: z.array(z.object({ agent: z.string(), id: z.string(), reason: skillStaleReasonSchema }).strict()),
    restoredPins: z.array(z.object({ agent: z.string(), id: z.string() }).strict()),
    unlistedPins: z.array(skillPinViewSchema.extend({ id: z.string() }).strict()),
    pinCheck: z.enum(["done", "empty_listing", "scope_missing"]),
    scopeMissing: z.boolean(),
    suggestedAction: z.string().nullable(),
  })
  .strict();

const skillsPinReturnSchema = z
  .object({
    pinned: z.literal(true),
    created: z.boolean(),
    id: z.string(),
    agent: z.string(),
    skill: z.string(),
    manifestDigest: z.string(),
    externalAllowed: z.boolean(),
    pluginRebuilt: z.boolean(),
    warnings: z.array(z.string()),
  })
  .strict();

const skillsUnpinReturnSchema = z
  .object({ removed: z.boolean(), id: z.string(), agent: z.string(), pluginRebuilt: z.boolean() })
  .strict();

const skillsReadReturnSchema = z
  .object({
    id: z.string(),
    server: z.string(),
    uri: z.string(),
    file: z.string(),
    digest: z.string(),
    size: z.number(),
    cached: z.boolean(),
    mimeType: z.string().nullable(),
    text: z.string().nullable(),
    truncated: z.boolean(),
    binary: z.boolean(),
  })
  .strict();

type SkillsListPayload = z.infer<typeof skillsListReturnSchema>;
type SkillsReadPayload = z.infer<typeof skillsReadReturnSchema>;

/** Remote skills load the MCP client: only a command that uses them loads the module. */
function mcpSkills(): Promise<typeof import("../../mcp/skills.js")> {
  return import("../../mcp/skills.js");
}

function failSkills(op: string, error: unknown, asJson?: boolean): never {
  if (error instanceof ContractError) throw error;
  if (error instanceof McpSkillsError) {
    failMcp(op, error.code, error.message, {
      asJson,
      exitCode: error.exitCode,
      ...(error.suggestedAction ? { suggestedAction: error.suggestedAction } : {}),
    });
  }
  // Anything else may quote remote content or a URL: it never leaves as text.
  failMcp(op, "MCP_SKILLS_FAILED", "The remote skill operation could not be completed.", { asJson });
}

async function requireGatewayForSkills(op: string, asJson?: boolean) {
  const { getMcpGateway } = await import("../../mcp/gateway.js");
  const gateway = getMcpGateway();
  if (gateway) return gateway;
  failMcp(op, "MCP_GATEWAY_UNAVAILABLE", "The Ravi MCP gateway is not running in this daemon; nothing was sent.", {
    asJson,
    suggestedAction: "Check the daemon (ravi daemon status) and retry",
    details: { retryable: true },
  });
}

function parseForwarded<T>(op: string, schema: z.ZodType<T>, value: unknown, asJson?: boolean): T {
  const parsed = schema.safeParse(value);
  if (parsed.success) return parsed.data;
  failMcp(op, "GATEWAY_RESPONSE_INVALID", "The Ravi daemon answered in an unexpected shape.", { asJson });
}

function printSkillsList(payload: SkillsListPayload): void {
  if (!payload.supported) {
    console.log(`MCP server ${payload.server} does not declare the skills extension.`);
  } else {
    console.log(`Skills of ${payload.server} (${payload.skills.length}/${payload.total})`);
  }
  if (payload.scopeMissing && payload.suggestedAction) console.log(`warning: ${payload.suggestedAction}`);
  for (const skill of payload.skills) {
    const files = skill.dynamic ? "dynamic" : `${skill.files} files`;
    console.log(`${skill.id ?? skill.uri}  ${skill.name}  (${files})`);
    if (skill.description) console.log(`  ${skill.description}`);
    for (const pin of skill.pins) {
      console.log(
        `  pinned to ${pin.agent} as ravi-library:${pin.skill} [${pin.state}${pin.staleReason ? `: ${pin.staleReason}` : ""}${pin.externalAllowed ? ", external" : ""}]`,
      );
    }
  }
  if (payload.unlistedPins.length) {
    console.log("Pins of skills this server does not list:");
    for (const pin of payload.unlistedPins) {
      console.log(
        `  ${pin.id} -> ${pin.agent} as ravi-library:${pin.skill} [${pin.state}${pin.staleReason ? `: ${pin.staleReason}` : ""}${pin.externalAllowed ? ", external" : ""}]`,
      );
    }
  }
  if (payload.pinCheck === "empty_listing" && payload.supported) {
    console.log(
      "The listing is empty (no skills, the organization's skills off, or a login without the skills scope): pins were left as they are.",
    );
  }
  for (const stale of payload.stalePins) console.log(`stale now: ${stale.id} for ${stale.agent} (${stale.reason})`);
  for (const restored of payload.restoredPins) {
    console.log(`active again: ${restored.id} for ${restored.agent} (listed again on its approved manifest)`);
  }
  if (payload.skills.length) console.log("Pin one with: ravi mcp skills pin <server> <id> --agent <id> --execute");
  if (payload.pagination.nextCommand) console.log(`Next: ${payload.pagination.nextCommand}`);
}

function printSkillRead(payload: SkillsReadPayload): void {
  console.log(
    `[remote skill ${payload.id}, file ${payload.file}, from MCP server ${payload.server}; verified against the approved digest]`,
  );
  if (payload.binary || payload.text === null) {
    console.log(`[binary file, ${payload.size} bytes, not shown]`);
    return;
  }
  console.log(payload.text);
  if (payload.truncated) console.log(`[cut at ${MCP_SKILL_READ_TEXT_CAP_BYTES} bytes]`);
}

@Group({
  name: "mcp.skills",
  description: "Remote skills of MCP servers: list, pin to an agent, read on demand",
  scope: "admin",
})
export class McpSkillsCommands {
  @Command({
    name: "list",
    description: "List the skills an MCP server offers (manifests only) and check the pins against them",
    remoteTimeoutMs: MCP_SKILLS_REMOTE_TIMEOUT_MS,
    helpAfter: `
RULES
  The operator's own turn only (the listing is the organization's catalog):
  any other turn is refused (exit 3) before anything is sent. Reads the
  server's skill manifests (skills/list, every page); never a skill file.
  --limit and --offset page what is returned; total counts every skill.
  The pins of every agent are checked against the listing: a pinned skill
  listed on another manifest goes stale (manifest_changed), one no longer
  listed goes stale (gone), and a gone pin listed again on exactly its
  approved manifest is active again. An empty listing changes no pin (a
  server answers it for no skills, for skills switched off and for a login
  without the skills scope). scopeMissing says the stored login lacks the
  skills scope the server advertises. Pins of skills the server does not
  list are shown apart (unlistedPins). Runs in the Ravi daemon: from a
  terminal it needs a running daemon and a context credential.

EXAMPLES
  ravi mcp skills list ravi-console --json
  ravi mcp skills list docs --agent main --limit 20 --offset 20`,
  })
  @CommandAccess({ kind: "read", resource: "mcp.skills", action: "list", risk: "low" })
  @Scope("open")
  @Returns(skillsListReturnSchema)
  async list(
    @Arg("server", { description: "Server name" }) server: string,
    @Option({ flags: "--agent <id>", description: "The agent, only when the context belongs to none" })
    agent?: string,
    @Option({ flags: "--limit <n>", description: "Page size (1 to 500)", defaultValue: "50" }) limit?: string,
    @Option({ flags: "--offset <n>", description: "Offset", defaultValue: "0" }) offset?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp skills list";
    const serverName = typeof server === "string" ? server.trim() : "";
    if (!serverName || serverName.length > 64) usage(op, "Give the server name.", { asJson });
    const pageLimit = Number(limit ?? "50");
    const pageOffset = Number(offset ?? "0");
    if (!Number.isInteger(pageLimit) || pageLimit < 1 || pageLimit > MCP_SKILLS_LIST_MAX) {
      usage(op, `--limit must be an integer from 1 to ${MCP_SKILLS_LIST_MAX}.`, { asJson });
    }
    if (!Number.isInteger(pageOffset) || pageOffset < 0) {
      usage(op, "--offset must be a non-negative integer.", { asJson });
    }
    const agentName = agent?.trim() || undefined;
    let payload: SkillsListPayload;
    if (!runsInDaemon()) {
      const forwarded = await forwardToDaemon(
        op,
        "list",
        {
          server: serverName,
          ...(agentName ? { agent: agentName } : {}),
          limit: String(pageLimit),
          offset: String(pageOffset),
        },
        asJson,
        MCP_SKILLS_REMOTE_TIMEOUT_MS,
        ["mcp", "skills"],
      );
      payload = parseForwarded(op, skillsListReturnSchema, forwarded, asJson);
    } else {
      const scope = resolveMcpTurnScope(op, agent, asJson);
      const gateway = await requireGatewayForSkills(op, asJson);
      let listed: Awaited<ReturnType<typeof listMcpServerSkills>>;
      try {
        listed = await (await mcpSkills()).listMcpServerSkills(
          gateway,
          { context: scope.context, agentId: scope.agentId },
          serverName,
          {},
          { limit: pageLimit, offset: pageOffset },
        );
      } catch (error) {
        failSkills(op, error, asJson);
      }
      payload = {
        ...listed,
        pagination: buildOffsetPagination({
          limit: pageLimit,
          offset: pageOffset,
          returned: listed.skills.length,
          total: listed.total,
          nextCommand: (nextOffset) =>
            buildCommand([
              "ravi",
              "mcp",
              "skills",
              "list",
              serverName,
              agentName && "--agent",
              agentName,
              "--limit",
              pageLimit,
              "--offset",
              nextOffset,
            ]),
        }),
      };
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSkillsList(payload);
    return payload;
  }

  @Command({
    name: "pin",
    description: "Pin a remote skill of an MCP server to an agent; dry-run unless --execute",
    remoteTimeoutMs: MCP_SKILLS_REMOTE_TIMEOUT_MS,
    helpAfter: `
RULES
  The operator's own turn only. Reads the skill's manifest (skills/get) and
  binds the approval to its digest; no skill file is fetched, now or at
  listing time. The agent then loads a stub, ravi-library:mcp-<server>-<slug>,
  that tells it to run ravi mcp skills read <id> when the task needs the
  skill. A skill with a dynamic file list is refused, and so is one the agent
  already gets from a Console Library pin. Without --external the stub loads
  only in the operator's own turns. --external on an attachment whose
  audience is operator is not refused, but the plan and the result warn
  (warnings): the stub then loads on other people's turns, where every read
  fails MCP_AUDIENCE until the audience is widened:
    ravi mcp set <server> --audience any --agent <id> --execute
  Pinning again re-approves the current manifest (a stale pin becomes active). The skill is given by its id, its
  URI or its path (a trailing /SKILL.md is the skill itself), as ravi mcp
  skills list prints them. The dry run reads the
  one manifest so the plan shows what the approval binds to (manifestDigest);
  --digest <sha256> makes --execute pin only that manifest.

EXAMPLES
  ravi mcp skills pin ravi-console mcp:ravi-console:project/prs/weekly-report --agent main --json
  ravi mcp skills pin ravi-console project/prs/weekly-report --agent main --digest sha256:<hex> --execute`,
  })
  @CommandAccess({
    kind: "mutate",
    resource: "mcp.skills",
    action: "pin",
    risk: "medium",
    requiresConfirmation: true,
  })
  @Returns(skillsPinReturnSchema)
  async pin(
    @Arg("server", { description: "Server name" }) server: string,
    @Arg("skill", { description: "Skill id (mcp:<server>:<path>), URI or path" }) skill: string,
    @Option({ flags: "--agent <id>", description: "The agent to pin it to (needed when the context has none)" })
    agent?: string,
    @Option({ flags: "--external", description: "Also load it in turns with people outside the organization" })
    external?: boolean,
    @Option({
      flags: "--digest <sha256>",
      description: "Pin only if the manifest still has this digest (the one the dry run showed)",
    })
    digest?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
    @Option({
      flags: "--execute",
      description: "Actually pin it; default is a dry-run that only shows the plan (exit 3)",
    })
    execute?: boolean,
  ) {
    const op = "mcp skills pin";
    const serverName = typeof server === "string" ? server.trim() : "";
    const skillArg = typeof skill === "string" ? skill.trim() : "";
    if (!serverName || serverName.length > 64) usage(op, "Give the server name.", { asJson });
    if (!skillArg || skillArg.length > 400) usage(op, "Give the skill id, URI or path.", { asJson });
    const expectedDigest = digest?.trim() || undefined;
    if (expectedDigest !== undefined && !/^sha256:[0-9a-f]{64}$/.test(expectedDigest)) {
      usage(op, "--digest is sha256:<64 hex>, as the dry run prints it.", { asJson });
    }
    let payload: z.infer<typeof skillsPinReturnSchema>;
    if (!runsInDaemon()) {
      const forwarded = await forwardToDaemon(
        op,
        "pin",
        {
          server: serverName,
          skill: skillArg,
          ...(agent?.trim() ? { agent: agent.trim() } : {}),
          ...(external === true ? { external: true } : {}),
          ...(expectedDigest ? { digest: expectedDigest } : {}),
          ...(execute === true ? { execute: true } : {}),
        },
        asJson,
        MCP_SKILLS_REMOTE_TIMEOUT_MS,
        ["mcp", "skills"],
      );
      payload = parseForwarded(op, skillsPinReturnSchema, forwarded, asJson);
    } else {
      const approvedBy = requireOperatorTurn(op, "pin a remote skill to an agent", asJson);
      const scope = resolveMcpTurnScope(op, agent, asJson);
      const gateway = await requireGatewayForSkills(op, asJson);
      let prepared: Awaited<ReturnType<typeof prepareMcpSkillPin>>;
      try {
        prepared = await (await mcpSkills()).prepareMcpSkillPin(
          gateway,
          { context: scope.context, agentId: scope.agentId },
          { server: serverName, skill: skillArg, externalAllowed: external === true },
        );
      } catch (error) {
        failSkills(op, error, asJson);
      }
      if (expectedDigest && expectedDigest !== prepared.plan.manifestDigest) {
        failMcp(
          op,
          "MCP_SKILL_MANIFEST_CHANGED",
          `The manifest of ${prepared.plan.id} changed since its digest was shown; nothing was pinned.`,
          { asJson, suggestedAction: "Run the dry run again and review the new manifest" },
        );
      }
      if (execute !== true) contractDryRun(op, { ...prepared.plan }, { asJson });
      try {
        payload = (await mcpSkills()).executeMcpSkillPin(prepared, { approvedBy });
      } catch (error) {
        failSkills(op, error, asJson);
      }
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      `${payload.created ? "Pinned" : "Re-approved"} ${payload.id} to ${payload.agent} as ravi-library:${payload.skill}`,
    );
    for (const warning of payload.warnings) console.log(`warning: ${warning}`);
    if (!payload.pluginRebuilt)
      console.log("The plugin could not be rebuilt now; new sessions load it after the next rebuild.");
    return payload;
  }

  @Command({
    name: "unpin",
    description: "Unpin a remote skill from an agent (applies at once)",
    helpAfter: `
RULES
  Reduces authority, so it applies at once. The agent is the context's agent,
  or --agent; a turn of one agent unpins for another only on the operator's
  own turn. New sessions stop loading the stub; a read is refused at once.

EXAMPLES
  ravi mcp skills unpin mcp:ravi-console:project/prs/weekly-report --agent main --json`,
  })
  @CommandAccess({ kind: "mutate", resource: "mcp.skills", action: "unpin", risk: "low" })
  @Returns(skillsUnpinReturnSchema)
  async unpin(
    @Arg("id", { description: "Skill id (mcp:<server>:<path>)" }) id: string,
    @Option({ flags: "--agent <id>", description: "The agent to unpin it from" }) agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp skills unpin";
    const ctx = getContext();
    const contextAgent = (ctx?.agentId ?? ctx?.context?.agentId ?? "").trim() || undefined;
    const requested = agent?.trim() || undefined;
    const agentId = requested ?? contextAgent;
    if (!agentId) usage(op, "Name the agent with --agent <id>.", { asJson });
    if (contextAgent && requested && requested !== contextAgent) {
      let own = false;
      try {
        own = isOperatorOwnTurn();
      } catch {
        // no-cause: a turn that cannot be classified is not the operator's own; the refusal below applies.
        own = false;
      }
      if (!own) {
        failMcp(
          op,
          "OPERATOR_TURN_REQUIRED",
          `This turn belongs to agent ${contextAgent}; it cannot unpin for another.`,
          {
            asJson,
            exitCode: CONTRACT_EXIT_POLICY,
            suggestedAction: "Leave out --agent",
          },
        );
      }
    }
    let payload: z.infer<typeof skillsUnpinReturnSchema>;
    try {
      payload = (await mcpSkills()).unpinMcpSkill({ agentId, id: typeof id === "string" ? id : "" });
    } catch (error) {
      failSkills(op, error, asJson);
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    console.log(
      payload.removed
        ? `Unpinned ${payload.id} from ${payload.agent}`
        : `${payload.id} was not pinned to ${payload.agent}`,
    );
    return payload;
  }

  @Command({
    name: "read",
    description: "Read a pinned remote skill (or one of its files), verified against its approved digest",
    remoteTimeoutMs: MCP_SKILLS_REMOTE_TIMEOUT_MS,
    helpAfter: `
RULES
  Reads one file of a remote skill pinned to this turn's agent: SKILL.md by
  default, or --file <relative path> from the skill's manifest. The pin must
  be active, the turn must be the operator's own unless the pin is external,
  and the turn must be allowed to use the server. The server's manifest must
  still match the approved digest, and the file must match its own digest;
  otherwise nothing is shown and the pin goes stale. A pin that went stale
  because the server no longer had the skill (gone) is active again once the
  server lists it on exactly the approved manifest. Files are cached by
  digest, with their media type, and verified again on every read. Each read,
  refused or not, is traced (mcp.skill; never the content). The content
  comes from a remote server: it grants no tool or permission. Runs in the
  Ravi daemon.

EXAMPLES
  ravi mcp skills read mcp:ravi-console:project/prs/weekly-report
  ravi mcp skills read mcp:ravi-console:project/prs/weekly-report --file references/GUIDE.md --json`,
  })
  @CommandAccess({ kind: "read", resource: "mcp.skills", action: "read", risk: "low" })
  @Scope("open")
  @Returns(skillsReadReturnSchema)
  async read(
    @Arg("id", { description: "Skill id (mcp:<server>:<path>)" }) id: string,
    @Option({ flags: "--file <path>", description: "A file of the skill, relative to its root (default SKILL.md)" })
    file?: string,
    @Option({ flags: "--agent <id>", description: "The agent, only when the context belongs to none" })
    agent?: string,
    @Option({ flags: "--json", description: "Print raw JSON result" }) asJson?: boolean,
  ) {
    const op = "mcp skills read";
    const skillId = typeof id === "string" ? id.trim() : "";
    if (!skillId || skillId.length > 300) usage(op, "Give the skill id (mcp:<server>:<path>).", { asJson });
    if (file !== undefined && (typeof file !== "string" || file.length > 400))
      usage(op, "--file is too long.", { asJson });
    let payload: SkillsReadPayload;
    if (!runsInDaemon()) {
      const forwarded = await forwardToDaemon(
        op,
        "read",
        {
          id: skillId,
          ...(file !== undefined ? { file } : {}),
          ...(agent?.trim() ? { agent: agent.trim() } : {}),
        },
        asJson,
        MCP_SKILLS_REMOTE_TIMEOUT_MS,
        ["mcp", "skills"],
      );
      payload = parseForwarded(op, skillsReadReturnSchema, forwarded, asJson);
    } else {
      const scope = resolveMcpTurnScope(op, agent, asJson);
      const gateway = await requireGatewayForSkills(op, asJson);
      try {
        payload = await (await mcpSkills()).readMcpSkill(
          gateway,
          { context: scope.context, agentId: scope.agentId },
          { id: skillId, ...(file !== undefined ? { file } : {}) },
        );
      } catch (error) {
        failSkills(op, error, asJson);
      }
    }
    if (asJson) {
      printJson(payload);
      return payload;
    }
    printSkillRead(payload);
    return payload;
  }
}
