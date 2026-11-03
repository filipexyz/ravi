/**
 * The Console side of `/connectors/approvals/<id>`: a write an agent asked
 * to run waits for its owner here.
 *
 * The Worker owns the approval, decrypts its preview and decides every
 * state. The Console only vouches for the person: they own the approval
 * (or, on an organization account nobody manages, they are an owner or
 * admin of its organization), they are an active member of its
 * organization, and their role there includes `console.connectors`. The
 * organization comes from the plain metadata row, never from the workspace
 * cookie, so a link opened from a chat lands in the right organization.
 * Someone else's approval is not found, and an impersonation session never
 * sees the preview or decides. The Worker checks the same again.
 */

import { eq } from "drizzle-orm";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { getConsoleUserFromAuth, type ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import { featureDenial, workspaceInOrganization, type ConnectAccessDenial } from "./connect-grants";
import {
  ConsoleConnectorClientError,
  decideApproval,
  getApproval,
  type ApprovalDecision,
  type ApprovalDetail,
  type ConsoleConnectorActorContext,
} from "./console-client";
import { isConnectorAdminRole, isImpersonatedSession } from "./internal-api";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ApprovalOwner = {
  id: string;
  organizationId: string;
  ownerUserId: string;
  /** On an organization account nobody manages: every active owner and admin of the organization decides. */
  unmanaged: boolean;
};

export type ApprovalAccess =
  | { kind: "ok"; actor: ConsoleConnectorActorContext; workspace: ConsoleWorkspace; approvalId: string }
  | { kind: "not_found" }
  | { kind: "denied"; reason: ConnectAccessDenial };

export function normalizeApprovalId(value: string | null | undefined) {
  const id = value?.trim() ?? "";
  return UUID_RE.test(id) ? id.toLowerCase() : null;
}

/** The approval's organization and owner, and whether its account has a manager. Plain metadata; nothing is decrypted. */
export async function findApprovalOwner(approvalId: string): Promise<ApprovalOwner | null> {
  const table = schema.connectorActionApprovals;
  const connections = schema.providerConnections;
  const [row] = await db
    .select({
      id: table.id,
      managedByUserId: connections.managedByUserId,
      organizationId: table.organizationId,
      ownerUserId: table.ownerUserId,
      scopeKind: connections.scopeKind,
    })
    .from(table)
    .leftJoin(connections, eq(connections.id, table.providerConnectionId))
    .where(eq(table.id, approvalId))
    .limit(1);
  if (!row) return null;
  return {
    id: row.id,
    organizationId: row.organizationId,
    ownerUserId: row.ownerUserId,
    unmanaged: row.scopeKind === "organization" && !row.managedByUserId,
  };
}

export type ApprovalDeps = {
  findOwner: (approvalId: string) => Promise<ApprovalOwner | null>;
  currentUserId: (auth: ConsoleAuthState) => Promise<string>;
  workspaceIn: (auth: ConsoleAuthState, organizationId: string) => Promise<ConsoleWorkspace | null>;
  featureDenial: (workspace: ConsoleWorkspace) => Promise<ConnectAccessDenial | null>;
};

const defaultDeps: ApprovalDeps = {
  currentUserId: async (auth) => (await getConsoleUserFromAuth(auth)).id,
  featureDenial,
  findOwner: findApprovalOwner,
  workspaceIn: workspaceInOrganization,
};

/** Swaps the lookups the approval routes use, in route tests. Returns a function that restores them. */
export function replaceApprovalDepsForTests(overrides: Partial<ApprovalDeps>) {
  const saved = { ...defaultDeps };
  Object.assign(defaultDeps, overrides);
  return () => {
    Object.assign(defaultDeps, saved);
  };
}

/** Who the Console speaks for on this approval, or why it won't. */
export async function resolveApprovalAccess(
  auth: ConsoleAuthState,
  rawId: string,
  deps: ApprovalDeps = defaultDeps,
): Promise<ApprovalAccess> {
  if (isImpersonatedSession(auth)) return { kind: "denied", reason: "impersonation" };
  const approvalId = normalizeApprovalId(rawId);
  if (!approvalId) return { kind: "not_found" };
  const owner = await deps.findOwner(approvalId);
  if (!owner) return { kind: "not_found" };
  // The account owner decides; on an organization account nobody manages,
  // so does any owner or admin of its organization (the Worker asked one of
  // them and lists it to all). Anyone else learns nothing about it.
  const own = owner.ownerUserId === (await deps.currentUserId(auth));
  if (!own && !owner.unmanaged) return { kind: "not_found" };
  const workspace = await deps.workspaceIn(auth, owner.organizationId);
  if (!own && !isConnectorAdminRole(workspace?.membership.role)) return { kind: "not_found" };
  if (!workspace) return { kind: "denied", reason: "not_member" };
  const denial = await deps.featureDenial(workspace);
  if (denial) return { kind: "denied", reason: denial };
  return {
    actor: { organizationId: workspace.organization.id, userId: workspace.user.id },
    approvalId,
    kind: "ok",
    workspace,
  };
}

export type ApprovalPageState =
  /** `checkedAt`: when the Worker answered, so the page reads expiry the same on server and client. */
  | { state: "ready"; approval: ApprovalDetail; checkedAt: number }
  | { state: "not_found" }
  | { state: "denied"; reason: ConnectAccessDenial }
  /** The Worker could not be asked (not configured, unreachable). */
  | { state: "unavailable"; code: string };

/** What `/connectors/approvals/<id>` shows. Inert: reading decides nothing. */
export async function getApprovalPageState(
  auth: ConsoleAuthState,
  rawId: string,
  deps?: ApprovalDeps,
): Promise<ApprovalPageState> {
  const access = await resolveApprovalAccess(auth, rawId, deps);
  if (access.kind === "not_found") return { state: "not_found" };
  if (access.kind === "denied") return { reason: access.reason, state: "denied" };
  try {
    const approval = await getApproval(access.actor, access.approvalId);
    return { approval, checkedAt: Date.now(), state: "ready" };
  } catch (error) {
    if (error instanceof ConsoleConnectorClientError && [403, 404, 410].includes(error.status)) {
      return { state: "not_found" };
    }
    return { code: unavailableCode(error), state: "unavailable" };
  }
}

/** A Worker 401 refused the Console's signature, not the person. */
function unavailableCode(error: unknown) {
  if (!(error instanceof ConsoleConnectorClientError)) return "internal_error";
  return error.status === 401 || error.status >= 500 ? "connector_service_unavailable" : error.code;
}

/** Errors the approval routes answer with, as HTTP status and code. */
export class ApprovalStepError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ApprovalStepError";
  }
}

function accessError(access: Exclude<ApprovalAccess, { kind: "ok" }>) {
  if (access.kind === "not_found") return new ApprovalStepError(404, "not_found");
  return new ApprovalStepError(403, access.reason);
}

/** The approval as the get route answers it, for whoever decides it. */
export async function getApprovalForOwner(
  auth: ConsoleAuthState,
  rawId: string,
  deps?: ApprovalDeps,
): Promise<ApprovalDetail> {
  const access = await resolveApprovalAccess(auth, rawId, deps);
  if (access.kind !== "ok") throw accessError(access);
  return getApproval(access.actor, access.approvalId);
}

/** "Approve" or "Deny". The Worker answers the approval's status after the decision. */
export async function decideApprovalFlow(
  auth: ConsoleAuthState,
  rawId: string,
  decision: ApprovalDecision,
  deps?: ApprovalDeps,
): Promise<{ status: string }> {
  const access = await resolveApprovalAccess(auth, rawId, deps);
  if (access.kind !== "ok") throw accessError(access);
  return decideApproval(access.actor, access.approvalId, decision);
}
