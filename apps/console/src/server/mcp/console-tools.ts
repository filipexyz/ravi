// Console mode of mcp.ravi.so: the Console operation registry served as MCP
// tools, run as the person who signed in through the bridge's OAuth. The
// Worker resolves the token to (organizationId, userId, bridgeId, scopes) and
// calls the internal routes under `/api/internal/mcp/console/**` with the
// Worker HMAC; this module re-checks the membership, builds the actor and
// runs the registry. Writes take two calls: the first returns a preview and a
// short-lived confirmation token, the second (same input + token) runs it.
// A cloud agent run (a token of a project's cloud bridge) skips that step: its
// writes run only against an approval the person gave in the Console, or at
// once when the agent's writes are automatic.
// See `.ravi/specs/console/mcp-bridges/SPEC.md` (Console mode).

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";

import { and, eq, gt, isNull } from "drizzle-orm";
import { ZodError, z } from "zod";

import { ConsoleApiError } from "@/server/console/api-error";
import {
  CLOUD_BRIDGE_KIND,
  consumeCloudApproval,
  mcpToolName,
  resolveCloudRunCaller,
  type CloudRunCaller,
} from "@/server/console/cloud-agents/mcp";
import {
  CLOUD_RUNS_START_OPERATION_ID,
  describeOperationChange,
  listOperationsForActor,
  operationAllowedForBoundProject,
  runOperation,
  type OperationActor,
  type OperationChangeLine,
  type OperationClass,
  type OperationDefinition,
  type OperationRunResult,
} from "@/server/console/operations";
import { getPagesConnectorCatalogEntry, validateCatalogInput } from "@/server/console/pages/connectors/catalog";
import { db, schema } from "@/server/db";
import { getMcpHmacConfig, McpHmacError, verifyMcpHmacRequest, type McpHmacConfig } from "@/server/mcp/internal-hmac";

/** OAuth scopes of the Console mode. Granted on the bridge consent screen. */
export const CONSOLE_MCP_SCOPES = {
  read: "mcp.console.tools.read",
  write: "mcp.console.tools.write",
} as const;

/** How long a write preview's confirmation token stays valid. */
export const CONSOLE_MCP_CONFIRMATION_TTL_MS = 5 * 60_000;

/** Largest internal request body accepted from the Worker. */
export const CONSOLE_MCP_MAX_BODY_BYTES = 256 * 1024;

const CONFIRMATION_TOKEN_PREFIX = "rmc1";
const CONFIRMATION_KEY_CONTEXT = "ravi.mcp.console.confirmation.v1";
const CONFIRMATION_ARGUMENT = "confirmationToken";

const WRITE_CONFIRMATION_GUIDANCE =
  "This tool changes data, so it runs in two steps. Call it first without confirmationToken: nothing changes, and the result is a preview of the change plus a confirmationToken. Show that preview to the person and ask whether to go ahead. Only after the person agrees, call this tool again with exactly the same arguments plus confirmationToken (valid for 5 minutes). Never confirm on the person's behalf.";

const CLOUD_WRITE_GUIDANCE =
  "This tool changes data. Call it once with the final arguments: the person approves the call in the Ravi Console before it runs (agents set to automatic writes run it at once). If it is refused, do not retry it; say what you wanted to change.";

const CLOUD_WRITE_NOT_APPROVED =
  "The person denied this change or has not approved it. Do not retry it; tell the person what you wanted to change.";

export type ConsoleMcpCaller = {
  organizationId: string;
  userId: string;
  bridgeId: string;
  /** The OAuth scopes of the access token, as the Worker resolved them. */
  scopes: readonly string[];
  requestId: string;
  /** The access token's row id, sent by the Worker; ties a cloud bridge call to its run. */
  tokenId?: string | null;
};

export type ConsoleMcpMember = {
  orgRole: string;
  email: string | null;
  /** The token belongs to a project's cloud agents bridge (a cloud run token). */
  cloudBridge?: boolean;
};

export type ConsoleMcpToolAnnotations = {
  title: string;
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
};

export type ConsoleMcpTool = {
  operationId: string;
  title: string;
  description: string;
  class: OperationClass;
  needsConfirmation: boolean;
  inputSchema: Record<string, unknown>;
  annotations: ConsoleMcpToolAnnotations;
};

export type ConsoleMcpCallResult =
  | { status: "ok"; operationId: string; class: OperationClass; output: unknown }
  | {
      status: "confirmation_required";
      operationId: string;
      class: OperationClass;
      summary: string;
      changes: OperationChangeLine[];
      confirmationToken: string;
      expiresAt: string;
    };

export type ConsoleMcpConfirmationKeys = {
  current: { id: string; key: string };
  previous?: { id: string; key: string };
};

export type ConsoleMcpToolsDeps = {
  loadMember?: (input: { organizationId: string; userId: string; bridgeId: string; tokenId: string | null; scopes: string[] }) => Promise<ConsoleMcpMember | null>;
  listOperations?: typeof listOperationsForActor;
  runOperation?: (input: Parameters<typeof runOperation>[0]) => Promise<OperationRunResult>;
  describeChange?: typeof describeOperationChange;
  /** Checks a write's input before a preview is issued; throws ConsoleApiError/ZodError when invalid. */
  validateWriteInput?: (definition: OperationDefinition, input: Record<string, unknown>) => void;
  confirmationKeys?: () => ConsoleMcpConfirmationKeys | null;
  now?: () => number;
  randomId?: () => string;
  resolveCloudRun?: (caller: { organizationId: string; userId: string; bridgeId: string; tokenId: string | null }) => Promise<CloudRunCaller | null>;
  consumeCloudApproval?: typeof consumeCloudApproval;
};

/** Tools this person may call through this token: reads with the read scope, writes also with the write scope. */
export async function listConsoleMcpTools(caller: ConsoleMcpCaller, deps: ConsoleMcpToolsDeps = {}) {
  requireScope(caller, CONSOLE_MCP_SCOPES.read);
  const { actor, cloudBridge } = await actorFor(caller, deps);
  const definitions = (deps.listOperations ?? listOperationsForActor)(actor);
  const tools: ConsoleMcpTool[] = [];
  for (const definition of definitions) {
    if (!toolAllowedOnMcp(definition)) continue;
    if (definition.class === "write" && !caller.scopes.includes(CONSOLE_MCP_SCOPES.write)) continue;
    if (cloudBridge && definition.id === CLOUD_RUNS_START_OPERATION_ID) continue;
    // A cloud run sees only what stays in its project: no calendar, bugs, Library or control of other runs.
    if (cloudBridge && !operationAllowedForBoundProject(definition.id)) continue;
    tools.push(toolFor(definition, cloudBridge ? "cloud_run" : "person"));
  }
  return { tools };
}

/**
 * Calls one operation. A read runs at once. A write without a valid
 * `confirmationToken` never runs: it returns the preview and a token bound to
 * (person, organization, operation, input); the same call with the token runs it.
 */
export async function callConsoleMcpTool(
  caller: ConsoleMcpCaller,
  input: { operationId: string; arguments: Record<string, unknown> },
  deps: ConsoleMcpToolsDeps = {},
): Promise<ConsoleMcpCallResult> {
  requireScope(caller, CONSOLE_MCP_SCOPES.read);
  const { actor, cloudBridge } = await actorFor(caller, deps);
  const definition = (deps.listOperations ?? listOperationsForActor)(actor).find(
    (candidate) => candidate.id === input.operationId,
  );
  if (!definition || !toolAllowedOnMcp(definition)) {
    throw new ConsoleApiError(404, { error: "operation_not_found" });
  }
  const run = deps.runOperation ?? ((args) => runOperation(args));

  if (cloudBridge) return callAsCloudRun(caller, actor, definition, input.arguments, deps);

  if (!definition.needsConfirmation) {
    const result = await run({ id: definition.id, actor, input: input.arguments });
    return { status: "ok", operationId: result.id, class: result.class, output: result.output };
  }

  requireScope(caller, CONSOLE_MCP_SCOPES.write);
  const { [CONFIRMATION_ARGUMENT]: rawToken, ...operationInput } = input.arguments;
  const keys = (deps.confirmationKeys ?? confirmationKeysFromEnv)();
  if (!keys) throw new ConsoleApiError(503, { error: "operation_unavailable", reason: "confirmation_not_configured" });
  const now = (deps.now ?? Date.now)();
  const inputHash = canonicalInputHash(operationInput);
  const binding = { userId: caller.userId, organizationId: caller.organizationId, operationId: definition.id, inputHash };

  if (rawToken === undefined || rawToken === null || rawToken === "") {
    try {
      (deps.validateWriteInput ?? validateWriteInputWithCatalog)(definition, operationInput);
    } catch (error) {
      if (error instanceof ZodError) throw payloadInvalid(error);
      throw error;
    }
    const tokenId = (deps.randomId ?? randomUUID)();
    const expiresAtMs = now + CONSOLE_MCP_CONFIRMATION_TTL_MS;
    const changes = (deps.describeChange ?? describeOperationChange)(definition.id, operationInput);
    return {
      status: "confirmation_required",
      operationId: definition.id,
      class: definition.class,
      summary: `${definition.title}. Nothing has changed yet. Show this preview to the person and call again with the same arguments and confirmationToken only after they agree.`,
      changes,
      confirmationToken: signConfirmationToken({ ...binding, tokenId, expiresAtMs }, keys),
      expiresAt: new Date(expiresAtMs).toISOString(),
    };
  }

  if (typeof rawToken !== "string") throw new ConsoleApiError(400, { error: "confirmation_invalid" });
  const verified = verifyConfirmationToken(rawToken, binding, keys, now);
  if (!verified.ok) throw new ConsoleApiError(409, { error: verified.error });

  const result = await run({
    id: definition.id,
    actor,
    input: operationInput,
    confirmed: true,
    idempotencySeed: verified.tokenId,
  });
  return { status: "ok", operationId: result.id, class: result.class, output: result.output };
}

/**
 * A call through a cloud run token. Every call, reads included, belongs to an
 * active run of the token and stays in that run's project. Runs never start
 * runs. A write needs the person's approval of this exact call (same run, tool
 * and input), consumed once, unless every run it may belong to writes
 * automatically.
 */
async function callAsCloudRun(
  caller: ConsoleMcpCaller,
  member: OperationActor,
  definition: OperationDefinition,
  args: Record<string, unknown>,
  deps: ConsoleMcpToolsDeps,
): Promise<ConsoleMcpCallResult> {
  if (definition.id === CLOUD_RUNS_START_OPERATION_ID) {
    throw new ConsoleApiError(403, { error: "operation_forbidden", reason: "A cloud agent run cannot start another run." });
  }
  const cloud = await (deps.resolveCloudRun ?? resolveCloudRunCaller)({
    organizationId: caller.organizationId,
    userId: caller.userId,
    bridgeId: caller.bridgeId,
    tokenId: caller.tokenId ?? null,
  });
  const runs = cloud?.runs ?? [];
  if (!cloud || runs.length === 0) {
    throw new ConsoleApiError(403, { error: "cloud_run_not_active", reason: "This cloud run has ended; its Ravi tools no longer work." });
  }
  for (const key of ["project", "projectRef"]) {
    const value = args[key];
    if (value === undefined) continue;
    const ref = typeof value === "string" ? value.trim() : "";
    if (ref !== cloud.project.id && ref.toLowerCase() !== cloud.project.slug.toLowerCase()) {
      throw new ConsoleApiError(403, {
        error: "operation_forbidden",
        reason: `A cloud run works only in its own project (${cloud.project.slug}).`,
      });
    }
  }
  // The registry keeps every operation in this project, whatever id or URL it is given.
  const actor: OperationActor = { ...member, boundProjectId: cloud.project.id };

  const run = deps.runOperation ?? ((runInput) => runOperation(runInput));
  if (!definition.needsConfirmation) {
    const result = await run({ id: definition.id, actor, input: args });
    return { status: "ok", operationId: result.id, class: result.class, output: result.output };
  }

  requireScope(caller, CONSOLE_MCP_SCOPES.write);
  const { [CONFIRMATION_ARGUMENT]: _ignored, ...operationInput } = args;
  try {
    (deps.validateWriteInput ?? validateWriteInputWithCatalog)(definition, operationInput);
  } catch (error) {
    if (error instanceof ZodError) throw payloadInvalid(error);
    throw error;
  }

  let seed: string;
  if (runs.every((candidate) => candidate.writes === "auto")) {
    seed = `cloud:${caller.requestId}`;
  } else {
    const approval = await (deps.consumeCloudApproval ?? consumeCloudApproval)({
      runIds: runs.map((candidate) => candidate.id),
      toolNames: [mcpToolName(definition.id), definition.id],
      inputHash: canonicalInputHash(operationInput),
      now: new Date((deps.now ?? Date.now)()),
    });
    if (!approval) throw new ConsoleApiError(403, { error: "cloud_run_write_not_approved", reason: CLOUD_WRITE_NOT_APPROVED });
    seed = `cloud:${approval.id}`;
  }
  const result = await run({ id: definition.id, actor, input: operationInput, confirmed: true, idempotencySeed: seed });
  return { status: "ok", operationId: result.id, class: result.class, output: result.output };
}

/** Route handler for `POST /api/internal/mcp/console/tools/list`. */
export async function handleConsoleToolsListRequest(
  request: Request,
  deps: ConsoleMcpToolsDeps & { hmacConfig?: McpHmacConfig | null } = {},
): Promise<Response> {
  return handleInternalRequest(request, callerBodySchema, deps, (caller) => listConsoleMcpTools(caller, deps));
}

/** Route handler for `POST /api/internal/mcp/console/tools/call`. */
export async function handleConsoleToolsCallRequest(
  request: Request,
  deps: ConsoleMcpToolsDeps & { hmacConfig?: McpHmacConfig | null } = {},
): Promise<Response> {
  return handleInternalRequest(request, callBodySchema, deps, (caller, body) =>
    callConsoleMcpTool(caller, { operationId: body.operationId, arguments: body.arguments ?? {} }, deps),
  );
}

const callerBodySchema = z.object({
  organizationId: z.string().uuid(),
  userId: z.string().uuid(),
  bridgeId: z.string().uuid(),
  scopes: z.array(z.string().min(1).max(100)).max(32),
  tokenId: z.string().min(1).max(100).optional(),
});

const callBodySchema = callerBodySchema.extend({
  operationId: z.string().min(1).max(200),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

async function handleInternalRequest<Schema extends z.ZodType<z.infer<typeof callerBodySchema>>>(
  request: Request,
  schema: Schema,
  deps: { hmacConfig?: McpHmacConfig | null },
  handler: (caller: ConsoleMcpCaller, body: z.infer<Schema>) => Promise<unknown>,
): Promise<Response> {
  const requestId = request.headers.get("x-request-id")?.slice(0, 200) || randomUUID();
  const bodyText = await request.text();
  if (Buffer.byteLength(bodyText) > CONSOLE_MCP_MAX_BODY_BYTES) return errorResponse(413, { error: "payload_invalid" }, requestId);

  try {
    await verifyMcpHmacRequest({ request, bodyText, config: deps.hmacConfig });
  } catch (error) {
    if (error instanceof McpHmacError && error.code === "server_not_configured") {
      return errorResponse(503, { error: "operation_unavailable" }, requestId);
    }
    return errorResponse(401, { error: "mcp_unauthorized" }, requestId);
  }

  let body: z.infer<Schema>;
  try {
    body = schema.parse(bodyText ? JSON.parse(bodyText) : {});
  } catch {
    return errorResponse(400, { error: "payload_invalid" }, requestId);
  }

  const caller: ConsoleMcpCaller = {
    organizationId: body.organizationId,
    userId: body.userId,
    bridgeId: body.bridgeId,
    scopes: body.scopes,
    requestId,
    tokenId: body.tokenId ?? null,
  };
  try {
    const result = await handler(caller, body);
    return Response.json(result, { status: 200, headers: { "x-request-id": requestId } });
  } catch (error) {
    if (error instanceof ConsoleApiError) return errorResponse(error.status, error.payload, requestId);
    if (error instanceof ZodError) return errorResponse(400, { error: "payload_invalid" }, requestId);
    return errorResponse(503, { error: "operation_unavailable" }, requestId);
  }
}

function errorResponse(status: number, payload: Record<string, unknown>, requestId: string) {
  return Response.json(payload, { status, headers: { "x-request-id": requestId } });
}

function requireScope(caller: ConsoleMcpCaller, scope: string) {
  if (!caller.scopes.includes(scope)) {
    throw new ConsoleApiError(403, { error: "scope_required", reason: scope });
  }
}

/** Visibility, invite and delete never reach MCP (K13); `destructive` operations stay off this surface. */
function toolAllowedOnMcp(definition: OperationDefinition) {
  return definition.surfaces.includes("mcp") && definition.class !== "destructive";
}

async function actorFor(caller: ConsoleMcpCaller, deps: ConsoleMcpToolsDeps): Promise<{ actor: OperationActor; cloudBridge: boolean }> {
  const member = await (deps.loadMember ?? loadActiveMember)({
    organizationId: caller.organizationId,
    userId: caller.userId,
    bridgeId: caller.bridgeId,
    tokenId: caller.tokenId ?? null,
    scopes: [...caller.scopes],
  });
  if (!member) throw new ConsoleApiError(403, { error: "mcp_access_revoked" });
  const actor: OperationActor = {
    kind: "member",
    organizationId: caller.organizationId,
    userId: caller.userId,
    email: member.email,
    orgRole: member.orgRole,
    surface: "mcp",
    requestId: caller.requestId,
    site: null,
    pagesSessionId: null,
  };
  return { actor, cloudBridge: member.cloudBridge === true };
}

/**
 * The person's role and email from the Console's own tables: an active
 * membership in an active organization, an active user, and the bridge the
 * token belongs to still active in that organization. Never the Worker's word.
 */
export async function loadActiveMember(input: {
  organizationId: string;
  userId: string;
  bridgeId: string;
  tokenId: string | null;
  scopes: string[];
}): Promise<ConsoleMcpMember | null> {
  if (!z.uuid().safeParse(input.tokenId).success) return null;
  const [row] = await db
    .select({
      role: schema.organizationMemberships.role,
      email: schema.users.primaryEmail,
      bridgeMetadata: schema.mcpBridges.metadataJson,
      tokenScopes: schema.mcpOAuthTokens.scopesJson,
    })
    .from(schema.organizationMemberships)
    .innerJoin(schema.users, eq(schema.users.id, schema.organizationMemberships.userId))
    .innerJoin(schema.organizations, eq(schema.organizations.id, schema.organizationMemberships.organizationId))
    .innerJoin(
      schema.mcpBridges,
      and(
        eq(schema.mcpBridges.organizationId, schema.organizationMemberships.organizationId),
        eq(schema.mcpBridges.id, input.bridgeId),
      ),
    )
    .innerJoin(schema.mcpOAuthTokens, and(eq(schema.mcpOAuthTokens.bridgeId, schema.mcpBridges.id),
      eq(schema.mcpOAuthTokens.organizationId, schema.organizations.id),
      eq(schema.mcpOAuthTokens.subjectUserId, schema.users.id),
      eq(schema.mcpOAuthTokens.projectId, schema.mcpBridges.projectId)))
    .where(
      and(
        eq(schema.organizationMemberships.organizationId, input.organizationId),
        eq(schema.organizationMemberships.userId, input.userId),
        eq(schema.organizationMemberships.status, "active"),
        eq(schema.users.status, "active"),
        eq(schema.organizations.status, "active"),
        eq(schema.mcpBridges.status, "active"),
        eq(schema.mcpOAuthTokens.id, input.tokenId!), isNull(schema.mcpOAuthTokens.revokedAt),
        gt(schema.mcpOAuthTokens.accessTokenExpiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row || input.scopes.some(scope => !row.tokenScopes.includes(scope))) return null;
  return {
    orgRole: row.role,
    email: row.email?.trim().toLowerCase() || null,
    cloudBridge: row.bridgeMetadata?.kind === CLOUD_BRIDGE_KIND,
  };
}

function toolFor(definition: OperationDefinition, audience: "person" | "cloud_run"): ConsoleMcpTool {
  const schema = structuredClone(definition.inputSchema("mcp")) as Record<string, unknown>;
  const isWrite = definition.needsConfirmation;
  if (isWrite && audience === "person") {
    const properties = (schema.properties as Record<string, unknown> | undefined) ?? {};
    schema.properties = {
      ...properties,
      [CONFIRMATION_ARGUMENT]: {
        type: "string",
        description:
          "Leave out on the first call. After the person agreed to the preview, pass the confirmationToken that preview returned, with the same other arguments.",
      },
    };
  }
  return {
    operationId: definition.id,
    title: definition.title,
    description: isWrite
      ? `${definition.description}\n\n${audience === "cloud_run" ? CLOUD_WRITE_GUIDANCE : WRITE_CONFIRMATION_GUIDANCE}`
      : definition.description,
    class: definition.class,
    needsConfirmation: definition.needsConfirmation,
    inputSchema: schema,
    annotations: {
      title: definition.title,
      readOnlyHint: definition.class === "read",
      destructiveHint: false,
      // Reads repeat without effect. A confirmed write is replay-safe for its own
      // token, but a new preview + token may write again, so writes say false.
      idempotentHint: definition.class === "read",
      openWorldHint: false,
    },
  };
}

/** Rejects a write's input before a preview is issued, with the registry's own validation. */
function validateWriteInputWithCatalog(definition: OperationDefinition, input: Record<string, unknown>) {
  const required = new Set(definition.inputSchema("mcp").required ?? []);
  if (required.has("project") && (typeof input.project !== "string" || !input.project.trim())) {
    throw new ConsoleApiError(400, { error: "payload_invalid", fieldErrors: { project: "Name the project (slug or id)." } });
  }
  definition.validateInput?.(input);
  const entry = getPagesConnectorCatalogEntry(definition.id);
  if (!entry) return;
  const { project: _project, ...rest } = input;
  const catalogInput: Record<string, unknown> = { ...rest };
  const catalogRequired = entry.inputSchema.required ?? [];
  if (catalogRequired.includes("idempotencyKey")) catalogInput.idempotencyKey = `op:${"0".repeat(40)}`;
  validateCatalogInput(entry, catalogInput);
}

function payloadInvalid(error: ZodError) {
  const fieldErrors: Record<string, string> = {};
  for (const issue of error.issues.slice(0, 20)) {
    const key = issue.path.join(".") || "input";
    fieldErrors[key] ??= issue.message;
  }
  return new ConsoleApiError(400, { error: "payload_invalid", fieldErrors });
}

// Confirmation tokens -------------------------------------------------------

type ConfirmationBinding = {
  userId: string;
  organizationId: string;
  operationId: string;
  inputHash: string;
};

type ConfirmationPayload = {
  v: 1;
  kid: string;
  jti: string;
  uid: string;
  org: string;
  op: string;
  ih: string;
  exp: number;
};

/** The Worker HMAC keys, never used directly: each derives a separate confirmation key. */
export function confirmationKeysFromEnv(env: NodeJS.ProcessEnv = process.env): ConsoleMcpConfirmationKeys | null {
  const config = getMcpHmacConfig(env);
  if (!config) return null;
  return {
    current: { id: config.currentId, key: config.currentKey },
    previous:
      config.previousId && config.previousKey ? { id: config.previousId, key: config.previousKey } : undefined,
  };
}

/** sha256 of the input with keys sorted at every level, so key order never changes the binding. */
export function canonicalInputHash(input: unknown): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value && typeof value === "object") {
    const objectValue = value as Record<string, unknown>;
    const keys = Object.keys(objectValue)
      .filter((key) => objectValue[key] !== undefined)
      .sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(objectValue[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function signConfirmationToken(
  input: ConfirmationBinding & { tokenId: string; expiresAtMs: number },
  keys: ConsoleMcpConfirmationKeys,
): string {
  const payload: ConfirmationPayload = {
    v: 1,
    kid: keys.current.id,
    jti: input.tokenId,
    uid: input.userId,
    org: input.organizationId,
    op: input.operationId,
    ih: input.inputHash,
    exp: Math.floor(input.expiresAtMs / 1000),
  };
  const encoded = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${CONFIRMATION_TOKEN_PREFIX}.${encoded}`;
  return `${signingInput}.${confirmationSignature(keys.current.key, signingInput)}`;
}

export function verifyConfirmationToken(
  token: string,
  binding: ConfirmationBinding,
  keys: ConsoleMcpConfirmationKeys,
  nowMs: number,
): { ok: true; tokenId: string } | { ok: false; error: "confirmation_invalid" | "confirmation_expired" } {
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== CONFIRMATION_TOKEN_PREFIX || token.length > 2048) {
    return { ok: false, error: "confirmation_invalid" };
  }
  let payload: ConfirmationPayload;
  try {
    payload = JSON.parse(Buffer.from(parts[1]!, "base64url").toString("utf8")) as ConfirmationPayload;
  } catch {
    return { ok: false, error: "confirmation_invalid" };
  }
  const key =
    payload.kid === keys.current.id
      ? keys.current.key
      : keys.previous && payload.kid === keys.previous.id
        ? keys.previous.key
        : null;
  if (!key) return { ok: false, error: "confirmation_invalid" };
  const expected = confirmationSignature(key, `${parts[0]}.${parts[1]}`);
  if (!safeEqual(expected, parts[2]!)) return { ok: false, error: "confirmation_invalid" };
  if (
    payload.v !== 1 ||
    typeof payload.jti !== "string" ||
    !payload.jti ||
    payload.uid !== binding.userId ||
    payload.org !== binding.organizationId ||
    payload.op !== binding.operationId ||
    payload.ih !== binding.inputHash
  ) {
    return { ok: false, error: "confirmation_invalid" };
  }
  if (typeof payload.exp !== "number" || payload.exp * 1000 <= nowMs) return { ok: false, error: "confirmation_expired" };
  return { ok: true, tokenId: payload.jti };
}

function confirmationSignature(key: string, signingInput: string) {
  const derived = createHmac("sha256", key).update(CONFIRMATION_KEY_CONTEXT).digest();
  return createHmac("sha256", derived).update(signingInput).digest("base64url");
}

function safeEqual(a: string, b: string) {
  const aBuffer = Buffer.from(a);
  const bBuffer = Buffer.from(b);
  return aBuffer.byteLength === bBuffer.byteLength && timingSafeEqual(aBuffer, bBuffer);
}
