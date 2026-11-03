/**
 * Plumbing shared by the `/api/internal/connectors/**` route handlers: the
 * request id, the same-origin check on browser posts, the Console session,
 * the selected workspace and the `console.connectors` feature. Handlers then
 * forward the person's identity to the Worker and map its errors.
 */

import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { getConsoleApiAuthState, type ConsoleAuthState } from "@/lib/auth/session";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { isTrustedConsolePost } from "@/server/console/ravi-link-web";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import type { ConsoleWorkspace } from "@/server/console/workspace";

import {
  ConsoleConnectorClientError,
  type ConsoleConnectorActorContext,
  type ConsoleConnectorAdminContext,
  type ConsoleConnectorMemberContext,
} from "./console-client";

export type ConnectorRequestGate = {
  requestId: string;
  auth: ConsoleAuthState;
};

export type ConnectorRouteGate = ConnectorRequestGate & {
  workspace: ConsoleWorkspace;
  actor: ConsoleConnectorActorContext;
};

/**
 * `write` (the default) refuses an impersonation session: whoever acts as the
 * person must not connect, rename, make default or disconnect their accounts.
 * `read` lets it look.
 */
export type ConnectorRequestAccess = "read" | "write";

export type ConnectorGateDeps = {
  authState: () => Promise<ConsoleAuthState | null>;
  selectedWorkspace: (auth: ConsoleAuthState, requestId: string) => Promise<ConsoleWorkspace | NextResponse>;
  featureError: (workspace: ConsoleWorkspace, requestId: string) => Promise<NextResponse | null>;
};

const gateDeps: ConnectorGateDeps = {
  authState: getConsoleApiAuthState,
  featureError: (workspace, requestId) => assertInternalConsoleFeature(workspace, "console.connectors", requestId),
  selectedWorkspace: getInternalSelectedConsoleWorkspace,
};

/** Swaps the session and workspace lookups in route tests. Returns a function that restores them. */
export function replaceConnectorGateDepsForTests(overrides: Partial<ConnectorGateDeps>) {
  const saved = { ...gateDeps };
  Object.assign(gateDeps, overrides);
  return () => {
    Object.assign(gateDeps, saved);
  };
}

/** A WorkOS impersonation session: someone else signed in as the person. */
export function isImpersonatedSession(auth: ConsoleAuthState) {
  return Boolean(auth.initialAuth?.impersonator);
}

export function connectorRequestId(request: Request) {
  return request.headers.get("x-request-id") ?? randomUUID();
}

export function connectorJson(payload: Record<string, unknown>, requestId: string, status = 200) {
  return NextResponse.json(
    { status: "ok", ...payload },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

export function connectorJsonError(status: number, code: string, requestId: string, reason?: string | null) {
  return NextResponse.json(
    { status: "error", code, ...(reason ? { reason } : {}) },
    { status, headers: { "cache-control": "no-store", "x-request-id": requestId } },
  );
}

/**
 * Worker `reason` details the screens tell apart. Only these reach the
 * browser; any other detail stays on the server.
 */
const PUBLIC_WORKER_REASONS = new Set(["shared_not_allowed", "agent_uses_other_account"]);

/**
 * Worker failures keep their status and code, except two that say nothing
 * about the person: a Worker-side 5xx, and a 401, which means the Worker
 * refused the Console's own signature (keys or clock). Both answer a bad
 * gateway; a 401 from these routes only ever means the person's session ended.
 * A refusal keeps its `reason` when it is one the screens tell apart.
 */
export function connectorErrorResponse(error: unknown, requestId: string) {
  if (error instanceof ConsoleConnectorClientError) {
    if (error.status === 401 || error.code === "connector_unauthorized") {
      console.error("connectors Worker refused the Console request signature", { requestId });
      return connectorJsonError(502, "connector_service_unavailable", requestId);
    }
    if (error.status >= 500) return connectorJsonError(502, error.code, requestId);
    const reason = error.reason && PUBLIC_WORKER_REASONS.has(error.reason) ? error.reason : null;
    return connectorJsonError(error.status, error.code, requestId, reason);
  }
  console.error("connectors internal API failed", {
    requestId,
    name: error instanceof Error ? error.name : "unknown",
  });
  return connectorJsonError(500, "internal_error", requestId);
}

/** Request id, same-origin check (posts), the Console session and, for writes, no impersonation. */
export async function openConnectorRequest(
  request: NextRequest,
  access: ConnectorRequestAccess = "write",
): Promise<ConnectorRequestGate | NextResponse> {
  const requestId = connectorRequestId(request);
  if (request.method !== "GET" && request.method !== "HEAD" && !isTrustedConsolePost(request)) {
    return connectorJsonError(403, "forbidden", requestId);
  }
  const auth = await gateDeps.authState();
  if (!auth) return connectorJsonError(401, "unauthorized", requestId);
  if (access === "write" && isImpersonatedSession(auth)) return connectorJsonError(403, "impersonation", requestId);
  return { auth, requestId };
}

/** `openConnectorRequest` plus the selected workspace and the connectors feature. */
export async function openConnectorRoute(
  request: NextRequest,
  access: ConnectorRequestAccess = "write",
): Promise<ConnectorRouteGate | NextResponse> {
  const gate = await openConnectorRequest(request, access);
  if (gate instanceof NextResponse) return gate;
  const workspace = await gateDeps.selectedWorkspace(gate.auth, gate.requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await gateDeps.featureError(workspace, gate.requestId);
  if (featureError) return featureError;
  return {
    ...gate,
    actor: { organizationId: workspace.organization.id, userId: workspace.user.id },
    workspace,
  };
}

/** A capability id such as `gmail.message.send`. */
export const connectorCapabilitySchema = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9_-]*(\.[a-z0-9_-]+)*$/)
  .max(120);

export const toolPolicySchema = z.enum(["always_allow", "needs_approval", "blocked"]);

const ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A connection or grant id from the path: a UUID, never anything else forwarded. */
export function isConnectorId(value: string | null | undefined): value is string {
  return Boolean(value && ID_RE.test(value));
}

/** An agent id as `ravi agents list` shows it, e.g. `main` or `support-bot`. */
export const agentIdSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .max(120);

export type ConnectorAdminRouteGate = ConnectorRouteGate & { admin: ConsoleConnectorAdminContext };

const ADMIN_ROLES = new Set(["owner", "admin"]);

export function isConnectorAdminRole(role: string | null | undefined) {
  return Boolean(role && ADMIN_ROLES.has(role));
}

/**
 * `openConnectorRoute` for `/org/connectors`: owners and admins only. The
 * Console refuses everyone else before the Worker hears of it, and still
 * sends the member's role so the Worker decides too.
 */
export async function openConnectorAdminRoute(
  request: NextRequest,
  access: ConnectorRequestAccess = "write",
): Promise<ConnectorAdminRouteGate | NextResponse> {
  const gate = await openConnectorRoute(request, access);
  if (gate instanceof NextResponse) return gate;
  const role = gate.workspace.membership.role;
  if (gate.workspace.membership.status !== "active" || !isConnectorAdminRole(role)) {
    return connectorJsonError(403, "connector_forbidden", gate.requestId);
  }
  return { ...gate, admin: { ...gate.actor, role } };
}

export type ConnectorMemberRouteGate = ConnectorRouteGate & { member: ConsoleConnectorMemberContext };

/**
 * `openConnectorRoute` for what the manager of an organization account may
 * do with it, whatever their role (list it, share it, revoke a share). Any
 * active member passes, with their role; the Worker decides whether they
 * manage the account or are an owner or admin.
 */
export async function openConnectorMemberRoute(
  request: NextRequest,
  access: ConnectorRequestAccess = "write",
): Promise<ConnectorMemberRouteGate | NextResponse> {
  const gate = await openConnectorRoute(request, access);
  if (gate instanceof NextResponse) return gate;
  if (gate.workspace.membership.status !== "active") {
    return connectorJsonError(403, "connector_forbidden", gate.requestId);
  }
  return { ...gate, member: { ...gate.actor, role: gate.workspace.membership.role } };
}

/**
 * Parses a JSON body against `schema`. An empty body counts as `{}` so posts
 * without fields (default, revoke) need none.
 */
export async function readConnectorBody<T extends z.ZodType>(
  request: Request,
  schema: T,
): Promise<z.infer<T> | null> {
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > 16 * 1024) return null;
  let value: unknown = {};
  if (text.trim()) {
    try {
      value = JSON.parse(text);
    } catch {
      return null;
    }
  }
  const parsed = schema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
