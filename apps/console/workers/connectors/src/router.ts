/**
 * `ravi-connectors` request router and cron handler.
 *
 * Routes connector OAuth, vault, and proxy traffic, and runs the
 * scheduled maintenance. `index.ts` (the Worker entrypoint) exports the
 * handler built here; tests build their own with fake adapters.
 */

import { backfillConnectionIdentity, needsIdentityBackfill } from "./account-identity";
import { createGoogleAdapter } from "./adapters/google";
import { executeAgentCapability, parseAgentExecMode } from "./agent-exec";
import {
  decideOwnerApproval,
  effectiveApprovalStatus,
  getOwnerApproval,
  listOwnerApprovals,
  type ApprovalDeps,
} from "./approvals";
import { buildGoogleHandlers } from "./capabilities/google";
import { authenticateCliBearer, CliAuthError, type CliPrincipal } from "./cli-auth";
import {
  LifecycleError,
  makeOwnConnectionDefault,
  renameOwnConnection,
  revokeConnection,
  revokeConnectionAsOperator,
  type LifecycleDeps,
} from "./connection-lifecycle";
import { getConnectionDetail, setConnectionToolPolicy } from "./connection-settings";
import {
  decideConsentRequest,
  listGivenGrants,
  resolveConsentRequest,
  revokeGivenGrant,
} from "./consent";
import { toCliConnectionDetail, toCliConnectionItem, toConnectionSummary } from "./connection-views";
import { importRootWrapKey } from "./crypto";
import {
  findActionApproval,
  findActiveCliSessionForUser,
  findPendingGrantById,
  findProviderConnectionById,
  isStaleClaim,
  listUsageForConnections,
  listUserConnections,
  openConnectorsDb,
  type ConnectorsDb,
  type ProviderConnectionRecord,
} from "./db";
import type { ConnectorsWorkerEnv } from "./env";
import { ConnectorHttpError, jsonError, jsonSuccess } from "./errors";
import { EXEC_CONTEXT_HEADER, parseExecContextHeader } from "./exec-context";
import { HmacAuthError, verifyHmacRequest, type HmacKeyMaterial } from "./hmac";
import {
  continueConnect,
  finishConnect,
  handleOAuthCallback,
  resolveConnect,
  startConnect,
  type OAuthRuntimeDeps,
} from "./oauth";
import { getOrgPolicy, listAdminConnections, requireOrganizationAdmin, setOrgPolicy } from "./org-admin";
import {
  changeOrgAccountManager,
  grantSharedAccount,
  listOrgAccounts,
  listSharedAccountGrants,
  revokeSharedAccountGrant,
} from "./org-connections";
import {
  executeCapability,
  PROXY_ERROR_PUBLIC_DETAILS,
  PROXY_ERROR_STATUS,
  ProxyError,
  type ProxyDeps,
} from "./proxy";
import { runScheduledMaintenance } from "./scheduled";
import { parseAccessMode, type ConnectorAccessMode } from "./scopes";
import { mintToken, StepUpRuntimeError, type StepUpRuntimeDeps } from "./stepup-runtime";
import { createWorkOSStepUpProvider } from "./stepup/workos";
import type { ConnectorAdapter } from "./adapters/adapter";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const LIST_IDENTITY_BACKFILL_LIMIT = 10;

export interface ConnectorsWorkerOptions {
  /** Provider adapters; defaults to the real Google adapter built from env secrets. */
  adapters?: (env: ConnectorsWorkerEnv) => Map<string, ConnectorAdapter>;
  sleep?: (ms: number) => Promise<void>;
}

export function createConnectorsWorker(options: ConnectorsWorkerOptions = {}) {
  const adaptersFor = options.adapters ?? buildAdapters;
  return {
    async fetch(request: Request, env: ConnectorsWorkerEnv, ctx: ExecutionContext): Promise<Response> {
      const requestId = crypto.randomUUID();
      const url = new URL(request.url);
      const db = openConnectorsDb(env.RAVI_CONSOLE_DB);
      let response: Response;
      try {
        response = await route({ request, url, env, db, requestId, adaptersFor, sleep: options.sleep });
      } catch (error) {
        response = handleError(error, requestId);
      }
      ctx.waitUntil(db.close().catch(() => {}));
      return response;
    },

    async scheduled(controller: ScheduledController, env: ConnectorsWorkerEnv, ctx: ExecutionContext): Promise<void> {
      const db = openConnectorsDb(env.RAVI_CONSOLE_DB);
      try {
        const rootWrapKey = await importRootWrapKey(env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64);
        const report = await runScheduledMaintenance({
          db,
          rootWrapKey,
          adapters: adaptersFor(env),
          dekKeyVersion: dekKeyVersion(env),
        });
        console.log("ravi-connectors scheduled maintenance", { cron: controller.cron, ...report });
      } catch (error) {
        console.error("ravi-connectors scheduled maintenance failed", {
          cron: controller.cron,
          name: error instanceof Error ? error.name : "unknown",
        });
      } finally {
        ctx.waitUntil(db.close().catch(() => {}));
      }
    },
  } satisfies ExportedHandler<ConnectorsWorkerEnv>;
}

interface RouteContext {
  request: Request;
  url: URL;
  env: ConnectorsWorkerEnv;
  db: ConnectorsDb;
  requestId: string;
  adaptersFor: (env: ConnectorsWorkerEnv) => Map<string, ConnectorAdapter>;
  sleep?: (ms: number) => Promise<void>;
}

async function route(ctx: RouteContext): Promise<Response> {
  const segments = ctx.url.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    return jsonSuccess({ ok: true, service: "ravi-connectors" }, ctx.requestId);
  }
  const [namespace, ...rest] = segments;

  if (namespace === "cli") return routeCli(ctx, rest);
  if (namespace === "ui") return routeUi(ctx, rest);
  if (namespace === "oauth") return routeOAuth(ctx, rest);
  if (namespace === "internal") return routeInternal(ctx, rest);

  throw new ConnectorHttpError(404, "not_found", "Unknown namespace");
}

// --------------------------------------------------------------------------
// CLI routes (CLI bearer authentication)
// --------------------------------------------------------------------------

async function routeCli(ctx: RouteContext, segments: string[]): Promise<Response> {
  const principal = await authenticateCli(ctx);

  // POST /cli/connect/start  (legacy direct start; `projectId` and `scopes` are accepted and ignored)
  if (matches(ctx, segments, "POST", ["connect", "start"])) {
    const body = asObject(await readJsonBody(ctx.request));
    const provider = stringValue(body.provider);
    if (!provider) {
      throw new ConnectorHttpError(400, "payload_invalid", "Missing provider");
    }
    const deps = await buildOAuthDeps(ctx);
    const result = await startConnect(deps, {
      provider,
      organizationId: principal.organizationId,
      userId: principal.userId,
      origin: "cli",
      cliSessionId: principal.sessionId,
      localInstallationId: principal.localInstallationId,
      accessMode: optionalAccessMode(body.accessMode),
      reconnectConnectionId: stringValue(body.reconnectConnectionId),
      requestedDisplayName: stringValue(body.displayName),
      requestId: ctx.requestId,
    });
    return jsonSuccess(
      {
        connectUrl: result.connectUrl,
        pendingGrantId: result.pendingGrantId,
        expiresAt: result.expiresAt.toISOString(),
      },
      ctx.requestId,
      { status: 201 },
    );
  }

  // GET /cli/connect/status/:pendingId
  if (matches(ctx, segments, "GET", ["connect", "status", ":pendingId"])) {
    const pendingId = requireUuidSegment(segments[2], "Pending grant not found");
    const pending = await findPendingGrantById(ctx.db, pendingId, principal.userId);
    if (!pending) throw new ConnectorHttpError(404, "not_found", "Pending grant not found");
    const expired = pending.status === "pending" && pending.expiresAt.getTime() < Date.now();
    // A grant being finished right now is consumed before its connection id
    // is written; report it as pending until the id is there, and as
    // rejected once the finish that claimed it is clearly gone.
    const status = expired
      ? "expired"
      : pending.status === "consumed" && !pending.resultingConnectionId
        ? isStaleClaim(pending) ? "rejected" : "pending"
        : pending.status;
    return jsonSuccess(
      {
        status,
        provider: pending.provider,
        connectorId: status === "consumed" ? pending.resultingConnectionId : null,
        expiresAt: pending.expiresAt.toISOString(),
      },
      ctx.requestId,
    );
  }

  // GET /cli/connect/show/:id
  if (matches(ctx, segments, "GET", ["connect", "show", ":id"])) {
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    const conn = await findProviderConnectionById(ctx.db, connectionId, principal.organizationId);
    if (!conn || conn.userId !== principal.userId || conn.provider === "github") {
      throw new ConnectorHttpError(404, "not_found", "Connection not found");
    }
    const usage = await listUsageForConnections(ctx.db, [conn.id]);
    return jsonSuccess(
      { connection: toCliConnectionDetail(conn, writeScopesFor(ctx, conn.provider), usage) },
      ctx.requestId,
    );
  }

  // POST /cli/connect/revoke/:id
  if (matches(ctx, segments, "POST", ["connect", "revoke", ":id"])) {
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    const deps = await buildLifecycleDeps(ctx);
    await revokeConnection(deps, {
      organizationId: principal.organizationId,
      userId: principal.userId,
      providerConnectionId: connectionId,
      requestId: ctx.requestId,
      origin: "user",
      actorType: "cli",
    });
    return jsonSuccess({ revoked: true }, ctx.requestId);
  }

  // GET /cli/connect/list[?provider=google][&project=<ignored>][&includeHistory=false]
  if (matches(ctx, segments, "GET", ["connect", "list"])) {
    const provider = stringValue(ctx.url.searchParams.get("provider"));
    // The CLI list has always included disconnected rows; `includeHistory=false` drops them.
    const historyParam = ctx.url.searchParams.get("includeHistory");
    const includeHistory = historyParam !== "false" && historyParam !== "0";
    const rows = await listOwnConnections(ctx, principal, { provider, includeHistory });
    const usage = await listUsageForConnections(ctx.db, rows.map((row) => row.id));
    return jsonSuccess(
      { connections: rows.map((row) => toCliConnectionItem(row, writeScopesFor(ctx, row.provider), usage)) },
      ctx.requestId,
    );
  }

  // POST /cli/exec/:connectionId
  //   headers: X-Ravi-Exec-Context (optional: an older CLI omits it), X-Ravi-Approval, X-Ravi-Step-Up
  if (matches(ctx, segments, "POST", ["exec", ":id"])) {
    const connectionId = requireUuidSegment(segments[1], "Connection not found");
    // A context that is present must be valid: fail closed before anything else.
    const execContext = parseExecContextHeader(ctx.request.headers.get(EXEC_CONTEXT_HEADER));
    if (!execContext.ok) {
      throw new ConnectorHttpError(400, "connector_exec_context_invalid", "Invalid X-Ravi-Exec-Context", {
        reason: execContext.reason,
      });
    }
    const body = asObject(await readJsonBody(ctx.request)) as {
      capability?: unknown;
      parameters?: unknown;
    };
    if (typeof body.capability !== "string" || !body.capability) {
      throw new ConnectorHttpError(400, "payload_invalid", "Missing capability");
    }
    const stepUpToken = ctx.request.headers.get("x-ravi-step-up")?.trim() || undefined;
    const approvalId = ctx.request.headers.get("x-ravi-approval")?.trim() || null;
    const deps = await buildProxyDeps(ctx);
    const result = await executeCapability(deps, {
      organizationId: principal.organizationId,
      userId: principal.userId,
      providerConnectionId: connectionId,
      capability: body.capability,
      parameters: body.parameters ?? {},
      requestId: ctx.requestId,
      actorType: "cli",
      stepUpToken,
      execContext: { context: execContext.context, legacyCli: execContext.legacyCli },
      localInstallationId: principal.localInstallationId,
      cliSessionId: principal.sessionId,
      approvalId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // POST /cli/agent-exec  { provider, capability, parameters, mode: "person_asking" | "shared" }
  //   headers: X-Ravi-Exec-Context (required: agentId; speaker.contactId for person_asking),
  //            X-Ravi-Approval, X-Ravi-Step-Up
  if (matches(ctx, segments, "POST", ["agent-exec"])) {
    const execContext = parseExecContextHeader(ctx.request.headers.get(EXEC_CONTEXT_HEADER));
    if (!execContext.ok) {
      throw new ConnectorHttpError(400, "connector_exec_context_invalid", "Invalid X-Ravi-Exec-Context", {
        reason: execContext.reason,
      });
    }
    const body = asObject(await readJsonBody(ctx.request));
    const provider = stringValue(body.provider);
    const mode = parseAgentExecMode(body.mode);
    if (!provider || typeof body.capability !== "string" || !body.capability) {
      throw new ConnectorHttpError(400, "payload_invalid", "Missing provider/capability");
    }
    if (!mode) throw new ConnectorHttpError(400, "payload_invalid", "mode must be person_asking or shared");
    const deps = await buildProxyDeps(ctx);
    const result = await executeAgentCapability(deps, {
      organizationId: principal.organizationId,
      userId: principal.userId,
      localInstallationId: principal.localInstallationId,
      cliSessionId: principal.sessionId,
      provider,
      capability: body.capability,
      parameters: body.parameters ?? {},
      mode,
      execContext: { context: execContext.context, legacyCli: execContext.legacyCli },
      approvalId: ctx.request.headers.get("x-ravi-approval")?.trim() || null,
      stepUpToken: ctx.request.headers.get("x-ravi-step-up")?.trim() || undefined,
      requestId: ctx.requestId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // GET /cli/approvals/:id  (the requester's own approvals only)
  if (matches(ctx, segments, "GET", ["approvals", ":id"])) {
    const approvalId = requireUuidSegment(segments[1], "Approval not found");
    const approval = await findActionApproval(ctx.db, approvalId);
    if (
      !approval ||
      approval.requestedByUserId !== principal.userId ||
      approval.organizationId !== principal.organizationId
    ) {
      throw new ConnectorHttpError(404, "not_found", "Approval not found");
    }
    return jsonSuccess(
      {
        status: effectiveApprovalStatus(approval),
        expiresAt: approval.expiresAt.toISOString(),
        capability: approval.capability,
      },
      ctx.requestId,
    );
  }

  throw new ConnectorHttpError(404, "not_found", `Unknown CLI route: ${segments.join("/")}`);
}

// --------------------------------------------------------------------------
// UI routes (HMAC server-to-server)
// --------------------------------------------------------------------------

async function routeUi(ctx: RouteContext, segments: string[]): Promise<Response> {
  const bodyText = await ctx.request.text();
  await verifyHmac(ctx, bodyText);
  const body = parseUiBody(bodyText);

  // POST /ui/stepup/mint
  if (matches(ctx, segments, "POST", ["stepup", "mint"])) {
    const challengeId = stringField(body, "challengeId");
    const userId = stringField(body, "userId");
    const organizationId = stringField(body, "organizationId");
    const providerResponse = body.providerResponse;
    if (!challengeId || !userId || !organizationId) {
      throw new ConnectorHttpError(400, "payload_invalid", "Missing challengeId/userId/organizationId");
    }
    const deps = await buildStepUpDeps(ctx);
    const minted = await mintToken(deps, {
      challengeId,
      userId,
      organizationId,
      providerResponse,
      requestId: ctx.requestId,
    });
    return jsonSuccess(
      {
        token: minted.token,
        expiresAt: minted.expiresAt.toISOString(),
        factor: minted.factor,
      },
      ctx.requestId,
    );
  }

  // POST /ui/connect/start
  //   { userId, organizationId, provider, accessMode?, reconnectConnectionId?, scopeKind?, role?,
  //     displayName?, projectId? (ignored), continueNow?, origin?, cliSessionId?, localInstallationId? }
  //   The Worker picks the provider scopes; a `scopes` field is ignored. `scopeKind:
  //   "organization"` (owners and admins, `role` required) starts an organization account.
  if (matches(ctx, segments, "POST", ["connect", "start"])) {
    const actor = requireActor(body);
    const provider = stringField(body, "provider");
    if (!provider) {
      throw new ConnectorHttpError(400, "payload_invalid", "Missing provider");
    }
    const scopeKind = stringField(body, "scopeKind") ?? "user";
    if (scopeKind !== "user" && scopeKind !== "organization") {
      throw new ConnectorHttpError(400, "payload_invalid", "scopeKind must be user or organization");
    }
    const origin = stringField(body, "origin") ?? "ui";
    if (origin !== "ui" && origin !== "cli") {
      throw new ConnectorHttpError(400, "payload_invalid", "Invalid origin");
    }
    const continueNow = body.continueNow === true;
    let cliSessionId: string | null = null;
    let localInstallationId: string | null = null;
    if (origin === "cli") {
      if (continueNow) {
        throw new ConnectorHttpError(400, "payload_invalid", "continueNow is only for the Console");
      }
      const session = await requireForwardedCliSession(ctx.db, actor, body);
      cliSessionId = session.id;
      localInstallationId = session.localInstallationId;
    }
    const deps = await buildOAuthDeps(ctx);
    const result = await startConnect(deps, {
      provider,
      organizationId: actor.organizationId,
      userId: actor.userId,
      origin,
      cliSessionId,
      localInstallationId,
      accessMode: optionalAccessMode(body.accessMode),
      reconnectConnectionId: stringField(body, "reconnectConnectionId"),
      requestedDisplayName: stringField(body, "displayName"),
      continueNow,
      scopeKind,
      claimedRole: body.role,
      requestId: ctx.requestId,
    });
    return jsonSuccess(
      {
        ...(result.connectUrl ? { connectUrl: result.connectUrl } : {}),
        ...(result.authorizationUrl ? { authorizationUrl: result.authorizationUrl } : {}),
        pendingGrantId: result.pendingGrantId,
        expiresAt: result.expiresAt.toISOString(),
      },
      ctx.requestId,
      { status: 201 },
    );
  }

  // POST /ui/connect/resolve  { userId, organizationId, connectToken }
  if (matches(ctx, segments, "POST", ["connect", "resolve"])) {
    const actor = requireActor(body);
    const deps = await buildOAuthDeps(ctx);
    const view = await resolveConnect(deps, {
      ...actor,
      connectToken: connectTokenField(body),
      requestId: ctx.requestId,
    });
    return jsonSuccess(view, ctx.requestId);
  }

  // POST /ui/connect/continue  { userId, organizationId, connectToken }
  if (matches(ctx, segments, "POST", ["connect", "continue"])) {
    const actor = requireActor(body);
    const deps = await buildOAuthDeps(ctx);
    const result = await continueConnect(deps, {
      ...actor,
      connectToken: connectTokenField(body),
      requestId: ctx.requestId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // POST /ui/connect/finish  { userId, organizationId, pendingId, resultToken }
  if (matches(ctx, segments, "POST", ["connect", "finish"])) {
    const actor = requireActor(body);
    const deps = await buildOAuthDeps(ctx);
    const result = await finishConnect(deps, {
      ...actor,
      pendingId: stringField(body, "pendingId") ?? "",
      resultToken: stringField(body, "resultToken") ?? "",
      requestId: ctx.requestId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // POST /ui/connect/list  { userId, organizationId, provider?, includeHistory?, projectId? (ignored) }
  if (matches(ctx, segments, "POST", ["connect", "list"])) {
    const actor = requireActor(body);
    const rows = await listOwnConnections(ctx, actor, {
      provider: stringField(body, "provider"),
      includeHistory: body.includeHistory === true,
    });
    const usage = await listUsageForConnections(ctx.db, rows.map((row) => row.id));
    return jsonSuccess(
      {
        connections: rows.map((row) => toConnectionSummary(row, writeScopesFor(ctx, row.provider), usage)),
      },
      ctx.requestId,
    );
  }

  // POST /ui/connect/detail/:id  { userId, organizationId }
  if (matches(ctx, segments, "POST", ["connect", "detail", ":id"])) {
    const actor = requireActor(body);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    const detail = await getConnectionDetail(
      { db: ctx.db, writeScopesFor: (provider) => writeScopesFor(ctx, provider) },
      { ...actor, providerConnectionId: connectionId },
    );
    return jsonSuccess(detail, ctx.requestId);
  }

  // POST /ui/connect/tools/:id  { userId, organizationId, capability, policy }
  if (matches(ctx, segments, "POST", ["connect", "tools", ":id"])) {
    const actor = requireActor(body);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    await setConnectionToolPolicy(
      { db: ctx.db },
      {
        ...actor,
        providerConnectionId: connectionId,
        capability: body.capability,
        policy: body.policy,
        requestId: ctx.requestId,
      },
    );
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/connect/rename/:id  { userId, organizationId, displayName }
  if (matches(ctx, segments, "POST", ["connect", "rename", ":id"])) {
    const actor = requireActor(body);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    await renameOwnConnection(
      { db: ctx.db },
      {
        ...actor,
        providerConnectionId: connectionId,
        displayName: body.displayName,
        requestId: ctx.requestId,
      },
    );
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/connect/default/:id  { userId, organizationId }
  if (matches(ctx, segments, "POST", ["connect", "default", ":id"])) {
    const actor = requireActor(body);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    await makeOwnConnectionDefault(
      { db: ctx.db },
      { ...actor, providerConnectionId: connectionId, requestId: ctx.requestId },
    );
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/connect/revoke/:id  { userId, organizationId }
  //   The owner's own connection; an organization account by its manager or an owner or admin.
  if (matches(ctx, segments, "POST", ["connect", "revoke", ":id"])) {
    const actor = requireActor(body);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    const deps = await buildLifecycleDeps(ctx);
    await revokeConnection(deps, {
      ...actor,
      providerConnectionId: connectionId,
      requestId: ctx.requestId,
      origin: "user",
      allowOrganization: true,
    });
    return jsonSuccess({ revoked: true }, ctx.requestId);
  }

  // POST /ui/approvals/list  { userId, organizationId }  (pending, waiting for this owner)
  if (matches(ctx, segments, "POST", ["approvals", "list"])) {
    const actor = requireActor(body);
    return jsonSuccess({ approvals: await listOwnerApprovals({ db: ctx.db }, actor) }, ctx.requestId);
  }

  // POST /ui/approvals/get/:id  { userId, organizationId }  (owner only, with the preview)
  if (matches(ctx, segments, "POST", ["approvals", "get", ":id"])) {
    const actor = requireActor(body);
    const approvalId = requireUuidSegment(segments[2], "Approval not found");
    const detail = await getOwnerApproval(await buildApprovalDeps(ctx), actor, approvalId);
    return jsonSuccess(detail, ctx.requestId);
  }

  // POST /ui/approvals/decide/:id  { userId, organizationId, decision: "approve" | "deny" }
  if (matches(ctx, segments, "POST", ["approvals", "decide", ":id"])) {
    const actor = requireActor(body);
    const approvalId = requireUuidSegment(segments[2], "Approval not found");
    const result = await decideOwnerApproval(await buildApprovalDeps(ctx), actor, {
      approvalId,
      decision: body.decision,
      requestId: ctx.requestId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // POST /ui/consent/resolve  { userId, organizationId, token }  (the person the request was made for)
  if (matches(ctx, segments, "POST", ["consent", "resolve"])) {
    const actor = requireActor(body);
    const view = await resolveConsentRequest({ db: ctx.db }, { ...actor, requestId: ctx.requestId }, body.token);
    return jsonSuccess(view, ctx.requestId);
  }

  // POST /ui/consent/decide  { userId, organizationId, token, decision: "approve" | "deny", connectionId? }
  if (matches(ctx, segments, "POST", ["consent", "decide"])) {
    const actor = requireActor(body);
    const result = await decideConsentRequest({ db: ctx.db }, { ...actor, requestId: ctx.requestId }, {
      token: body.token,
      decision: body.decision,
      connectionId: body.connectionId,
    });
    return jsonSuccess(result, ctx.requestId);
  }

  // POST /ui/consent/list  { userId, organizationId }  (grants the person gave)
  if (matches(ctx, segments, "POST", ["consent", "list"])) {
    const actor = requireActor(body);
    return jsonSuccess({ grants: await listGivenGrants({ db: ctx.db }, actor) }, ctx.requestId);
  }

  // POST /ui/consent/revoke/:grantId  { userId, organizationId }  (only the person who gave it)
  if (matches(ctx, segments, "POST", ["consent", "revoke", ":grantId"])) {
    const actor = requireActor(body);
    const grantId = requireUuidSegment(segments[2], "Grant not found");
    await revokeGivenGrant({ db: ctx.db }, { ...actor, requestId: ctx.requestId }, grantId);
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/org/...  { userId, organizationId, role?, ... }  (organization accounts)
  if (segments[0] === "org") {
    return routeUiOrg(ctx, segments.slice(1), body);
  }

  // POST /ui/admin/...  { userId, organizationId, role, ... }  (organization owners and admins)
  if (segments[0] === "admin") {
    return routeUiAdmin(ctx, segments.slice(1), body);
  }

  throw new ConnectorHttpError(404, "not_found", `Unknown UI route: ${segments.join("/")}`);
}

async function routeUiAdmin(
  ctx: RouteContext,
  segments: string[],
  body: Record<string, unknown>,
): Promise<Response> {
  const actor = requireActor(body);
  await requireOrganizationAdmin(ctx.db, actor, body.role);

  // POST /ui/admin/policy/get  { provider }
  if (matches(ctx, segments, "POST", ["policy", "get"])) {
    return jsonSuccess(
      await getOrgPolicy(ctx.db, { organizationId: actor.organizationId, provider: body.provider }),
      ctx.requestId,
    );
  }

  // POST /ui/admin/policy/set  { provider, enabled?, writesAllowed?, sharedAllowed?, toolCeilings? }
  if (matches(ctx, segments, "POST", ["policy", "set"])) {
    return jsonSuccess(
      await setOrgPolicy(ctx.db, { ...actor, body, requestId: ctx.requestId }),
      ctx.requestId,
    );
  }

  // POST /ui/admin/connections/list  { provider? }
  if (matches(ctx, segments, "POST", ["connections", "list"])) {
    const connections = await listAdminConnections(ctx.db, {
      organizationId: actor.organizationId,
      provider: body.provider,
    });
    return jsonSuccess({ connections }, ctx.requestId);
  }

  // POST /ui/admin/connections/revoke/:id
  if (matches(ctx, segments, "POST", ["connections", "revoke", ":id"])) {
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    await revokeConnectionAsOperator(await buildLifecycleDeps(ctx), {
      organizationId: actor.organizationId,
      operatorUserId: actor.userId,
      providerConnectionId: connectionId,
      requestId: ctx.requestId,
    });
    return jsonSuccess({ revoked: true }, ctx.requestId);
  }

  throw new ConnectorHttpError(404, "not_found", `Unknown UI route: admin/${segments.join("/")}`);
}

/**
 * Organization accounts. Changing their manager is for owners and admins;
 * listing them and shared grants also for the account's manager (the
 * Worker checks the membership row, not only the role the Console sent).
 */
async function routeUiOrg(
  ctx: RouteContext,
  segments: string[],
  body: Record<string, unknown>,
): Promise<Response> {
  const actor = requireActor(body);
  const withRequest = { ...actor, requestId: ctx.requestId };

  // POST /ui/org/connections/list  { role, provider?, includeHistory? }
  //   (owners and admins: every account; another member: those they manage)
  if (matches(ctx, segments, "POST", ["connections", "list"])) {
    const connections = await listOrgAccounts(
      { db: ctx.db, writeScopesFor: (provider) => writeScopesFor(ctx, provider) },
      { ...actor, claimedRole: body.role, provider: body.provider, includeHistory: body.includeHistory === true },
    );
    return jsonSuccess({ connections }, ctx.requestId);
  }

  // POST /ui/org/connections/owner/:id  { role, managedByUserId }
  if (matches(ctx, segments, "POST", ["connections", "owner", ":id"])) {
    await requireOrganizationAdmin(ctx.db, actor, body.role);
    const connectionId = requireUuidSegment(segments[2], "Connection not found");
    await changeOrgAccountManager({ db: ctx.db }, withRequest, {
      connectionId,
      managedByUserId: body.managedByUserId,
    });
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/org/shared/grant  { connectionId, installationId, agentId, conversations }
  if (matches(ctx, segments, "POST", ["shared", "grant"])) {
    const result = await grantSharedAccount({ db: ctx.db }, withRequest, body);
    return jsonSuccess(result, ctx.requestId, { status: 201 });
  }

  // POST /ui/org/shared/revoke/:grantId
  if (matches(ctx, segments, "POST", ["shared", "revoke", ":grantId"])) {
    const grantId = requireUuidSegment(segments[2], "Grant not found");
    await revokeSharedAccountGrant({ db: ctx.db }, withRequest, grantId);
    return jsonSuccess({ ok: true }, ctx.requestId);
  }

  // POST /ui/org/shared/list  { connectionId? }
  if (matches(ctx, segments, "POST", ["shared", "list"])) {
    const grants = await listSharedAccountGrants({ db: ctx.db }, actor, { connectionId: body.connectionId });
    return jsonSuccess({ grants }, ctx.requestId);
  }

  throw new ConnectorHttpError(404, "not_found", `Unknown UI route: org/${segments.join("/")}`);
}

// --------------------------------------------------------------------------
// OAuth callback (no auth header; state token validated inside)
// --------------------------------------------------------------------------

async function routeOAuth(ctx: RouteContext, segments: string[]): Promise<Response> {
  if (segments.length !== 2 || segments[1] !== "callback" || ctx.request.method !== "GET") {
    throw new ConnectorHttpError(404, "not_found", `Unknown OAuth route: ${segments.join("/")}`);
  }
  const deps = await buildOAuthDeps(ctx);
  const location = await handleOAuthCallback(deps, {
    provider: segments[0]!,
    code: ctx.url.searchParams.get("code"),
    state: ctx.url.searchParams.get("state"),
    error: ctx.url.searchParams.get("error"),
    requestId: ctx.requestId,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: location,
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "X-Ravi-Request-Id": ctx.requestId,
    },
  });
}

async function routeInternal(ctx: RouteContext, segments: string[]): Promise<Response> {
  if (segments[0] === "health") return jsonSuccess({ ok: true }, ctx.requestId);
  throw new ConnectorHttpError(404, "not_found", `Unknown internal route: ${segments.join("/")}`);
}

// --------------------------------------------------------------------------
// Lists
// --------------------------------------------------------------------------

/**
 * The caller's own connections. Legacy rows without an account email get
 * it from their stored id_token (a few per call) before the list is read.
 */
async function listOwnConnections(
  ctx: RouteContext,
  actor: { organizationId: string; userId: string },
  filter: { provider: string | null; includeHistory: boolean },
): Promise<ProviderConnectionRecord[]> {
  const query = () =>
    listUserConnections(ctx.db, {
      organizationId: actor.organizationId,
      userId: actor.userId,
      provider: filter.provider,
      includeHistory: filter.includeHistory,
    });
  const rows = await query();
  const candidates = rows.filter(needsIdentityBackfill).slice(0, LIST_IDENTITY_BACKFILL_LIMIT);
  if (candidates.length === 0) return rows;
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64);
  for (const row of candidates) {
    try {
      await backfillConnectionIdentity({ db: ctx.db, rootWrapKey }, row);
    } catch (error) {
      console.error("ravi-connectors identity backfill failed", {
        requestId: ctx.requestId,
        name: error instanceof Error ? error.name : "unknown",
      });
    }
  }
  return query();
}

function writeScopesFor(ctx: RouteContext, provider: string): readonly string[] {
  return ctx.adaptersFor(ctx.env).get(provider)?.writeScopes ?? [];
}

// --------------------------------------------------------------------------
// Auth helpers
// --------------------------------------------------------------------------

async function authenticateCli(ctx: RouteContext): Promise<CliPrincipal> {
  try {
    const { principal } = await authenticateCliBearer({
      request: ctx.request,
      db: ctx.db,
      cliAccessTokenSecret: ctx.env.RAVI_CONNECTORS_CLI_ACCESS_TOKEN_SECRET,
    });
    return principal;
  } catch (error) {
    if (error instanceof CliAuthError) {
      throw new ConnectorHttpError(401, "connector_unauthorized", "CLI bearer rejected");
    }
    throw error;
  }
}

async function verifyHmac(ctx: RouteContext, bodyText: string): Promise<void> {
  const keys: HmacKeyMaterial = {
    currentId: ctx.env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT_ID,
    currentKey: ctx.env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT,
    previousId: ctx.env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_PREVIOUS_ID,
    previousKey: ctx.env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_PREVIOUS,
  };
  try {
    await verifyHmacRequest({ request: ctx.request, bodyText, keys });
  } catch (error) {
    if (error instanceof HmacAuthError) {
      throw new ConnectorHttpError(401, "connector_unauthorized", "HMAC rejected");
    }
    throw error;
  }
}

/** The signed-in Console identity the HMAC request speaks for. */
function requireActor(body: Record<string, unknown>): { userId: string; organizationId: string } {
  const userId = stringField(body, "userId");
  const organizationId = stringField(body, "organizationId");
  if (!userId || !organizationId || !UUID_RE.test(userId) || !UUID_RE.test(organizationId)) {
    throw new ConnectorHttpError(400, "payload_invalid", "Missing userId/organizationId");
  }
  return { userId, organizationId };
}

/**
 * A CLI-originated start forwarded by the Console: the CLI session must be
 * the user's, active, and on an active installation.
 */
async function requireForwardedCliSession(
  db: ConnectorsDb,
  actor: { userId: string; organizationId: string },
  body: Record<string, unknown>,
): Promise<{ id: string; localInstallationId: string }> {
  const cliSessionId = stringField(body, "cliSessionId");
  if (!cliSessionId || !UUID_RE.test(cliSessionId)) {
    throw new ConnectorHttpError(400, "payload_invalid", "Missing cliSessionId");
  }
  const session = await findActiveCliSessionForUser(db, { sessionId: cliSessionId, ...actor });
  if (!session) {
    throw new ConnectorHttpError(403, "connector_forbidden", "CLI session is not active");
  }
  const claimedInstallation = stringField(body, "localInstallationId");
  if (claimedInstallation && claimedInstallation !== session.localInstallationId) {
    throw new ConnectorHttpError(400, "payload_invalid", "localInstallationId does not match the CLI session");
  }
  return session;
}

// --------------------------------------------------------------------------
// Dep builders
// --------------------------------------------------------------------------

let adaptersSingleton: Map<string, ConnectorAdapter> | null = null;

function buildAdapters(env: ConnectorsWorkerEnv): Map<string, ConnectorAdapter> {
  if (adaptersSingleton) return adaptersSingleton;
  const google = createGoogleAdapter({
    config: {
      clientId: env.GOOGLE_OAUTH_CLIENT_ID,
      clientSecret: env.GOOGLE_OAUTH_CLIENT_SECRET,
    },
    capabilities: buildGoogleHandlers(),
  });
  adaptersSingleton = new Map<string, ConnectorAdapter>([[google.providerId, google]]);
  return adaptersSingleton;
}

function dekKeyVersion(env: ConnectorsWorkerEnv): number {
  return Number.parseInt(env.RAVI_CONNECTORS_KEY_VERSION, 10) || 1;
}

async function buildOAuthDeps(ctx: RouteContext): Promise<OAuthRuntimeDeps> {
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64);
  return {
    db: ctx.db,
    rootWrapKey,
    dekKeyVersion: dekKeyVersion(ctx.env),
    adapters: ctx.adaptersFor(ctx.env),
    redirectBaseUrl: ctx.env.RAVI_CONNECTORS_BASE_URL,
    consoleBaseUrl: ctx.env.RAVI_CONSOLE_BASE_URL,
    pendingGrantTtlSeconds:
      Number.parseInt(ctx.env.RAVI_CONNECTORS_PENDING_GRANT_TTL_SECONDS, 10) || 600,
    sleep: ctx.sleep,
  };
}

async function buildLifecycleDeps(ctx: RouteContext): Promise<LifecycleDeps> {
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64);
  return {
    db: ctx.db,
    rootWrapKey,
    adapters: ctx.adaptersFor(ctx.env),
  };
}

async function buildProxyDeps(ctx: RouteContext): Promise<ProxyDeps> {
  const rootWrapKey = await importRootWrapKey(ctx.env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64);
  return {
    db: ctx.db,
    rootWrapKey,
    dekKeyVersion: dekKeyVersion(ctx.env),
    adapters: ctx.adaptersFor(ctx.env),
    stepUp: buildStepUpDepsSync(ctx),
    consoleBaseUrl: ctx.env.RAVI_CONSOLE_BASE_URL,
  };
}

async function buildApprovalDeps(ctx: RouteContext): Promise<ApprovalDeps> {
  return {
    db: ctx.db,
    rootWrapKey: await importRootWrapKey(ctx.env.RAVI_CONNECTORS_ROOT_WRAP_KEY_BASE64),
    dekKeyVersion: dekKeyVersion(ctx.env),
    consoleBaseUrl: ctx.env.RAVI_CONSOLE_BASE_URL,
  };
}

function buildStepUpDepsSync(ctx: RouteContext): StepUpRuntimeDeps {
  return {
    db: ctx.db,
    provider: createWorkOSStepUpProvider({
      consoleBaseUrl: ctx.env.RAVI_CONSOLE_BASE_URL,
      workosApiKey: ctx.env.WORKOS_API_KEY,
      hmacSecret: ctx.env.RAVI_CONNECTORS_VERCEL_HMAC_KEY_CURRENT,
    }),
    ttlSeconds: Number.parseInt(ctx.env.RAVI_CONNECTORS_STEPUP_TTL_SECONDS, 10) || 300,
  };
}

async function buildStepUpDeps(ctx: RouteContext): Promise<StepUpRuntimeDeps> {
  return buildStepUpDepsSync(ctx);
}

// --------------------------------------------------------------------------
// Util
// --------------------------------------------------------------------------

function matches(ctx: RouteContext, segments: string[], method: string, pattern: string[]): boolean {
  if (ctx.request.method !== method) return false;
  if (segments.length !== pattern.length) return false;
  return pattern.every((part, index) => part.startsWith(":") || segments[index] === part);
}

async function readJsonBody(request: Request): Promise<unknown> {
  const text = await request.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ConnectorHttpError(400, "payload_invalid", "Body is not valid JSON");
  }
}

function parseUiBody(bodyText: string): Record<string, unknown> {
  if (!bodyText.trim()) return {};
  try {
    return asObject(JSON.parse(bodyText) as unknown);
  } catch (error) {
    if (error instanceof ConnectorHttpError) throw error;
    throw new ConnectorHttpError(400, "payload_invalid", "Body is not valid JSON");
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConnectorHttpError(400, "payload_invalid", "Body must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function stringField(payload: Record<string, unknown>, key: string): string | null {
  return stringValue(payload[key]);
}

function connectTokenField(body: Record<string, unknown>): string {
  return stringField(body, "connectToken") ?? stringField(body, "token") ?? "";
}

function stringValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function optionalAccessMode(value: unknown): ConnectorAccessMode | null {
  if (value === undefined || value === null) return null;
  const mode = parseAccessMode(value);
  if (!mode) throw new ConnectorHttpError(400, "payload_invalid", "accessMode must be full or read_only");
  return mode;
}

function requireUuidSegment(value: string | undefined, notFoundMessage: string): string {
  if (!value || !UUID_RE.test(value)) throw new ConnectorHttpError(404, "not_found", notFoundMessage);
  return value;
}

function handleError(error: unknown, requestId: string): Response {
  if (error instanceof ConnectorHttpError) {
    return jsonError(error.status, error.code, requestId, error.details);
  }
  if (error instanceof ProxyError) {
    const details = PROXY_ERROR_PUBLIC_DETAILS.has(error.code)
      ? (error.details as Record<string, unknown> | undefined)
      : undefined;
    return jsonError(PROXY_ERROR_STATUS[error.code], error.code, requestId, details);
  }
  if (error instanceof StepUpRuntimeError) {
    return jsonError(400, "connector_stepup_rejected", requestId);
  }
  if (error instanceof LifecycleError) {
    const status = error.code === "connector_provider_error" ? 502
      : error.code === "payload_invalid" ? 400
      : 404;
    return jsonError(status, error.code, requestId);
  }
  console.error("ravi-connectors unexpected error", {
    requestId,
    name: error instanceof Error ? error.name : "unknown",
    message: error instanceof Error ? error.message : String(error),
  });
  return jsonError(500, "internal_error", requestId);
}

export interface ExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
  passThroughOnException(): void;
}

export interface ScheduledController {
  readonly scheduledTime: number;
  readonly cron: string;
  noRetry(): void;
}

interface ExportedHandler<Env> {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response;
  scheduled?(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> | void;
}

export interface DurableObjectState {
  id: { toString(): string };
}
