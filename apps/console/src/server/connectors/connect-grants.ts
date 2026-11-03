/**
 * The Console side of the identity-bound connect flow: `/connect/<token>`,
 * its "Continue" post and `/connect/finish`.
 *
 * The Worker owns the pending grant and decides every state. The Console only
 * applies the single "who can connect" rule before it vouches for the person:
 * they started the grant, they are an active member of the grant's
 * organization, and their role there includes `console.connectors`. The
 * grant's organization comes from the plain metadata row, never from the
 * workspace cookie, so a person with several organizations lands in the right
 * one. An impersonation session never connects anything.
 *
 * The browser that starts or continues a grant gets a short-lived cookie
 * naming it, and only a browser holding it can finish that grant.
 */

import { createHash } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NextRequest, NextResponse } from "next/server";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { getOptionalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getConsoleUserFromAuth,
  getConsoleWorkspace,
  type ConsoleWorkspace,
} from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { isImpersonatedSession } from "./internal-api";
import {
  ConsoleConnectorClientError,
  continueConnect,
  finishConnect,
  resolveConnect,
  type ConnectFinishResult,
  type ConnectResolveView,
  type ConsoleConnectorActorContext,
} from "./console-client";

const CONNECT_TOKEN_RE = /^[A-Za-z0-9_-]{16,256}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Why the Console refused to vouch for the person, before asking the Worker. */
export type ConnectAccessDenial = "not_member" | "feature_unavailable" | "feature_forbidden" | "impersonation";

export type ConnectGrantRef = { connectToken: string } | { pendingId: string };

export type ConnectGrantOwner = { id: string; organizationId: string; userId: string };

export type ConnectGrantAccess =
  /** `pendingId` is null when the grant row wasn't found and the Worker answers for it. */
  | { kind: "ok"; actor: ConsoleConnectorActorContext; workspace: ConsoleWorkspace; pendingId: string | null }
  /**
   * The signed-in person did not start this grant. `actor` names them in an
   * organization they are an active member of (the grant's when they belong
   * to it), or is null when they have none, and then nothing is forwarded.
   */
  | { kind: "user_mismatch"; actor: ConsoleConnectorActorContext | null }
  | { kind: "denied"; reason: ConnectAccessDenial }
  | { kind: "invalid" };

export function normalizeConnectToken(value: string | null | undefined) {
  const token = value?.trim() ?? "";
  return CONNECT_TOKEN_RE.test(token) ? token : null;
}

export function normalizePendingId(value: string | null | undefined) {
  const id = value?.trim() ?? "";
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** Same encoding as the Worker: sha256, standard base64. */
export function connectTokenHash(token: string) {
  return createHash("sha256").update(token).digest("base64");
}

/** The pending grant's id, organization and initiator. Plain metadata; nothing is decrypted. */
export async function findConnectGrantOwner(ref: ConnectGrantRef): Promise<ConnectGrantOwner | null> {
  const table = schema.connectorGrantsPending;
  const condition =
    "connectToken" in ref ? eq(table.connectTokenHash, connectTokenHash(ref.connectToken)) : eq(table.id, ref.pendingId);
  const [row] = await db
    .select({ id: table.id, organizationId: table.organizationId, userId: table.userId })
    .from(table)
    .where(condition)
    .limit(1);
  return row ?? null;
}

/** Whether the role and organization include `console.connectors`, in the words the pages use. */
export async function featureDenial(workspace: ConsoleWorkspace): Promise<ConnectAccessDenial | null> {
  try {
    await assertConsoleFeatureAccess(workspace, "console.connectors");
    return null;
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return error.payload.error === "feature_unavailable" ? "feature_unavailable" : "feature_forbidden";
    }
    throw error;
  }
}

/** The person's active workspace in one organization, or null when they aren't an active member there. */
export async function workspaceInOrganization(auth: ConsoleAuthState, organizationId: string) {
  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef: organizationId });
    return workspace.organization.id === organizationId && workspace.membership.status === "active" ? workspace : null;
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) return null;
    throw error;
  }
}

export type ConnectGrantDeps = {
  findOwner: (ref: ConnectGrantRef) => Promise<ConnectGrantOwner | null>;
  currentUserId: (auth: ConsoleAuthState) => Promise<string>;
  workspaceIn: (auth: ConsoleAuthState, organizationId: string) => Promise<ConsoleWorkspace | null>;
  selectedWorkspace: (auth: ConsoleAuthState) => Promise<ConsoleWorkspace | null>;
  featureDenial: (workspace: ConsoleWorkspace) => Promise<ConnectAccessDenial | null>;
};

const defaultDeps: ConnectGrantDeps = {
  currentUserId: async (auth) => (await getConsoleUserFromAuth(auth)).id,
  featureDenial,
  findOwner: findConnectGrantOwner,
  selectedWorkspace: getOptionalSelectedConsoleWorkspace,
  workspaceIn: workspaceInOrganization,
};

/** Swaps the lookups the routes use, in route tests. Returns a function that restores them. */
export function replaceConnectGrantDepsForTests(overrides: Partial<ConnectGrantDeps>) {
  const saved = { ...defaultDeps };
  Object.assign(defaultDeps, overrides);
  return () => {
    Object.assign(defaultDeps, saved);
  };
}

/**
 * Someone who didn't start the grant, named in an organization the Console
 * checked: the grant's when they are an active member there, else their own
 * selected one. The Worker still refuses them (the user differs) and records
 * whether they belong to the grant's organization.
 */
async function mismatchActor(
  auth: ConsoleAuthState,
  owner: ConnectGrantOwner,
  userId: string,
  deps: ConnectGrantDeps,
): Promise<ConsoleConnectorActorContext | null> {
  const member = await deps.workspaceIn(auth, owner.organizationId);
  if (member) return { organizationId: owner.organizationId, userId };
  const selected = await deps.selectedWorkspace(auth);
  return selected ? { organizationId: selected.organization.id, userId } : null;
}

/**
 * The workspace the Console speaks for in this grant. When the grant row is
 * not found the selected workspace is used and the Worker answers for the
 * token (usually `invalid`).
 */
export async function resolveConnectGrantAccess(
  auth: ConsoleAuthState,
  ref: ConnectGrantRef,
  deps: ConnectGrantDeps = defaultDeps,
): Promise<ConnectGrantAccess> {
  if (isImpersonatedSession(auth)) return { kind: "denied", reason: "impersonation" };
  const owner = await deps.findOwner(ref);
  let workspace: ConsoleWorkspace | null;
  if (owner) {
    const userId = await deps.currentUserId(auth);
    if (owner.userId !== userId) {
      return { actor: await mismatchActor(auth, owner, userId, deps), kind: "user_mismatch" };
    }
    workspace = await deps.workspaceIn(auth, owner.organizationId);
    if (!workspace) return { kind: "denied", reason: "not_member" };
  } else {
    workspace = await deps.selectedWorkspace(auth);
    if (!workspace) return { kind: "invalid" };
  }
  const denial = await deps.featureDenial(workspace);
  if (denial) return { kind: "denied", reason: denial };
  return {
    actor: { organizationId: workspace.organization.id, userId: workspace.user.id },
    kind: "ok",
    pendingId: owner?.id ?? null,
    workspace,
  };
}

// ---------------------------------------------------------------------------
// The browser a grant belongs to
// ---------------------------------------------------------------------------

const CONNECT_BROWSER_TTL_SECONDS = 600;

function secureCookies() {
  return process.env.NODE_ENV === "production";
}

/** One cookie per grant, so two connects in two tabs don't clash. `__Host-` needs HTTPS. */
export function connectBrowserCookieName(pendingId: string, secure = secureCookies()) {
  return `${secure ? "__Host-" : ""}ravi_connect_${pendingId.replace(/-/g, "")}`;
}

/** Marks the browser that started or continued the grant; it lives as long as the grant. */
export function bindConnectBrowser(response: NextResponse, pendingId: string | null | undefined) {
  const id = normalizePendingId(pendingId);
  if (!id) return response;
  const secure = secureCookies();
  response.cookies.set(connectBrowserCookieName(id, secure), "1", {
    httpOnly: true,
    maxAge: CONNECT_BROWSER_TTL_SECONDS,
    path: "/",
    sameSite: "lax",
    secure,
  });
  return response;
}

export function isConnectBrowserBound(request: Pick<NextRequest, "cookies">, pendingId: string) {
  const id = normalizePendingId(pendingId);
  return Boolean(id && request.cookies.get(connectBrowserCookieName(id))?.value);
}

// ---------------------------------------------------------------------------
// The three steps the pages and routes run
// ---------------------------------------------------------------------------

export type ConnectPageState =
  | ConnectResolveView
  | { state: "denied"; reason: ConnectAccessDenial }
  /** The Worker could not be asked (not configured, unreachable). */
  | { state: "unavailable"; code: string };

/** What `/connect/<token>` shows. Inert: resolving changes nothing. */
export async function getConnectPageState(
  auth: ConsoleAuthState,
  rawToken: string,
  deps?: ConnectGrantDeps,
): Promise<ConnectPageState> {
  const connectToken = normalizeConnectToken(rawToken);
  if (!connectToken) return { state: "invalid" };
  const access = await resolveConnectGrantAccess(auth, { connectToken }, deps);
  if (access.kind === "invalid") return { state: "invalid" };
  if (access.kind === "user_mismatch") {
    // Asked only so the Worker records the attempt; its answer is not shown.
    if (access.actor) await resolveConnect(access.actor, connectToken).catch(() => null);
    return { state: "user_mismatch" };
  }
  if (access.kind === "denied") return { reason: access.reason, state: "denied" };
  try {
    return await resolveConnect(access.actor, connectToken);
  } catch (error) {
    if (error instanceof ConsoleConnectorClientError && [400, 404, 409, 410].includes(error.status)) {
      return { state: "invalid" };
    }
    return { code: unavailableCode(error), state: "unavailable" };
  }
}

/** A Worker 401 refused the Console's signature, not the person. */
function unavailableCode(error: unknown) {
  if (!(error instanceof ConsoleConnectorClientError)) return "internal_error";
  return error.status === 401 ? "connector_service_unavailable" : error.code;
}

/** Errors the continue and finish steps answer with, as HTTP status and code. */
export class ConnectStepError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ConnectStepError";
  }
}

function accessError(access: Exclude<ConnectGrantAccess, { kind: "ok" | "user_mismatch" }>) {
  if (access.kind === "invalid") return new ConnectStepError(404, "connect_invalid");
  return new ConnectStepError(403, access.reason);
}

/**
 * "Continue to Google": the Worker generates state and PKCE for the initiator
 * only. `pendingId` names the grant so the route can mark this browser.
 */
export async function continueConnectFlow(
  auth: ConsoleAuthState,
  rawToken: string,
  deps?: ConnectGrantDeps,
): Promise<{ authorizationUrl: string; pendingId: string | null }> {
  const connectToken = normalizeConnectToken(rawToken);
  if (!connectToken) throw new ConnectStepError(404, "connect_invalid");
  const access = await resolveConnectGrantAccess(auth, { connectToken }, deps);
  if (access.kind === "user_mismatch") {
    // The Worker refuses and records it; nothing it answers reaches this person.
    if (access.actor) await continueConnect(access.actor, connectToken).catch(() => null);
    throw new ConnectStepError(403, "user_mismatch");
  }
  if (access.kind !== "ok") throw accessError(access);
  const result = await continueConnect(access.actor, connectToken);
  return { authorizationUrl: result?.authorizationUrl, pendingId: access.pendingId };
}

/**
 * Finishes after the provider's callback. A person who did not start the
 * grant is still forwarded, so the Worker rejects it and drops the code.
 * (Resolve and continue forward a mismatch too, so the Worker can record it.)
 * The initiator finishes only from the browser that started or continued the
 * grant (`browserBound`); elsewhere nothing is forwarded and the grant expires.
 */
export async function finishConnectFlow(
  auth: ConsoleAuthState,
  input: { pendingId: string; resultToken: string; browserBound: boolean },
  deps?: ConnectGrantDeps,
): Promise<ConnectFinishResult> {
  const pendingId = normalizePendingId(input.pendingId);
  if (!pendingId) return { state: "invalid" };
  const access = await resolveConnectGrantAccess(auth, { pendingId }, deps);
  if (access.kind === "invalid") return { state: "invalid" };
  if (access.kind === "denied") throw accessError(access);
  if (access.kind === "user_mismatch") {
    if (!access.actor) return { reason: "user_mismatch", state: "rejected" };
    return finishConnect(access.actor, { pendingId, resultToken: input.resultToken });
  }
  if (access.pendingId && !input.browserBound) throw new ConnectStepError(403, "connect_other_browser");
  return finishConnect(access.actor, { pendingId, resultToken: input.resultToken });
}
