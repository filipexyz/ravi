/**
 * The Console side of `/connectors/consent/<token>`: an agent asks once to
 * use the person's account whenever that person asks it something.
 *
 * The Worker owns the consent request and the grant and decides every
 * state. The Console only vouches for the person: the request was made for
 * them (the speaker its `ravi link` binding names), they are an active member
 * of its organization, and their role there includes `console.connectors`.
 * The organization comes from the plain metadata row, never from the
 * workspace cookie, so a link opened from a chat lands in the right
 * organization. An impersonation session never sees or answers a request.
 */

import { eq } from "drizzle-orm";

import type { ConsoleAuthState } from "@/lib/auth/session";
import { getOptionalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { getConsoleUserFromAuth, type ConsoleWorkspace } from "@/server/console/workspace";
import { db, schema } from "@/server/db";

import {
  connectTokenHash,
  featureDenial,
  normalizeConnectToken,
  workspaceInOrganization,
  type ConnectAccessDenial,
} from "./connect-grants";
import {
  ConsoleConnectorClientError,
  decideConsent,
  resolveConsent,
  type ConsentDecision,
  type ConsentDecisionResult,
  type ConsentView,
  type ConsoleConnectorActorContext,
} from "./console-client";
import { isImpersonatedSession } from "./internal-api";

export type ConsentRequestOwner = { organizationId: string; consoleUserId: string };

export type ConsentAccess =
  /** Also when the request row wasn't found: the Worker then answers for the token. */
  | { kind: "ok"; actor: ConsoleConnectorActorContext; workspace: ConsoleWorkspace }
  /**
   * The request was made for someone else. `actor` names the signed-in person
   * in the request's organization when they are an active member there, so the
   * Worker can record the attempt; otherwise nothing is forwarded.
   */
  | { kind: "user_mismatch"; actor: ConsoleConnectorActorContext | null }
  | { kind: "denied"; reason: ConnectAccessDenial }
  | { kind: "invalid" };

/** The consent request's organization and the person it was made for. Plain metadata. */
export async function findConsentRequestOwner(token: string): Promise<ConsentRequestOwner | null> {
  const table = schema.connectorConsentRequests;
  const [row] = await db
    .select({ consoleUserId: table.consoleUserId, organizationId: table.organizationId })
    .from(table)
    .where(eq(table.tokenHash, connectTokenHash(token)))
    .limit(1);
  return row ?? null;
}

export type ConsentDeps = {
  findRequest: (token: string) => Promise<ConsentRequestOwner | null>;
  currentUserId: (auth: ConsoleAuthState) => Promise<string>;
  workspaceIn: (auth: ConsoleAuthState, organizationId: string) => Promise<ConsoleWorkspace | null>;
  selectedWorkspace: (auth: ConsoleAuthState) => Promise<ConsoleWorkspace | null>;
  featureDenial: (workspace: ConsoleWorkspace) => Promise<ConnectAccessDenial | null>;
};

const defaultDeps: ConsentDeps = {
  currentUserId: async (auth) => (await getConsoleUserFromAuth(auth)).id,
  featureDenial,
  findRequest: findConsentRequestOwner,
  selectedWorkspace: getOptionalSelectedConsoleWorkspace,
  workspaceIn: workspaceInOrganization,
};

/** Swaps the lookups the consent page and routes use, in tests. Returns a function that restores them. */
export function replaceConsentDepsForTests(overrides: Partial<ConsentDeps>) {
  const saved = { ...defaultDeps };
  Object.assign(defaultDeps, overrides);
  return () => {
    Object.assign(defaultDeps, saved);
  };
}

/** Who the Console speaks for on this consent request, or why it won't. */
export async function resolveConsentAccess(
  auth: ConsoleAuthState,
  token: string,
  deps: ConsentDeps = defaultDeps,
): Promise<ConsentAccess> {
  if (isImpersonatedSession(auth)) return { kind: "denied", reason: "impersonation" };
  const owner = await deps.findRequest(token);
  let workspace: ConsoleWorkspace | null;
  if (owner) {
    const userId = await deps.currentUserId(auth);
    if (owner.consoleUserId !== userId) {
      const member = await deps.workspaceIn(auth, owner.organizationId);
      return {
        actor: member ? { organizationId: owner.organizationId, userId } : null,
        kind: "user_mismatch",
      };
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
    workspace,
  };
}

type PendingConsentView = Extract<ConsentView, { state: "pending" }>;

export type ConsentPageState =
  | Exclude<ConsentView, { state: "pending" }>
  | (PendingConsentView & {
      /** The request's organization, and whether the Console has it selected (connecting happens there). */
      organization: { id: string; name: string; selected: boolean };
      /** When the Worker answered, so the page reads expiry the same on server and client. */
      checkedAt: number;
    })
  | { state: "denied"; reason: ConnectAccessDenial }
  /** The Worker could not be asked (not configured, unreachable). */
  | { state: "unavailable"; code: string };

/** What `/connectors/consent/<token>` shows. Inert: resolving decides nothing. */
export async function getConsentPageState(
  auth: ConsoleAuthState,
  rawToken: string,
  deps: ConsentDeps = defaultDeps,
): Promise<ConsentPageState> {
  const token = normalizeConnectToken(rawToken);
  if (!token) return { state: "invalid" };
  const access = await resolveConsentAccess(auth, token, deps);
  if (access.kind === "invalid") return { state: "invalid" };
  if (access.kind === "user_mismatch") {
    // Asked only so the Worker records the attempt; its answer is not shown.
    if (access.actor) await resolveConsent(access.actor, token).catch(() => null);
    return { state: "user_mismatch" };
  }
  if (access.kind === "denied") return { reason: access.reason, state: "denied" };
  try {
    const view = await resolveConsent(access.actor, token);
    if (view.state !== "pending") return view;
    const selected = await deps.selectedWorkspace(auth).catch(() => null);
    return {
      ...view,
      checkedAt: Date.now(),
      organization: {
        id: access.workspace.organization.id,
        name: access.workspace.organization.name,
        selected: selected?.organization.id === access.workspace.organization.id,
      },
    };
  } catch (error) {
    if (error instanceof ConsoleConnectorClientError && [400, 404, 410].includes(error.status)) {
      return { state: "invalid" };
    }
    return { code: unavailableCode(error), state: "unavailable" };
  }
}

/** A Worker 401 refused the Console's signature, not the person. */
function unavailableCode(error: unknown) {
  if (!(error instanceof ConsoleConnectorClientError)) return "internal_error";
  return error.status === 401 || error.status >= 500 ? "connector_service_unavailable" : error.code;
}

/** Errors the consent routes answer with, as HTTP status and code. */
export class ConsentStepError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(code);
    this.name = "ConsentStepError";
  }
}

function accessError(access: Exclude<ConsentAccess, { kind: "ok" }>) {
  if (access.kind === "invalid") return new ConsentStepError(404, "consent_invalid");
  if (access.kind === "user_mismatch") return new ConsentStepError(403, "user_mismatch");
  return new ConsentStepError(403, access.reason);
}

/**
 * "Approve" or "Deny". Only the person the request was made for, in their own
 * session; anyone else's answer never reaches the Worker.
 */
export async function decideConsentFlow(
  auth: ConsoleAuthState,
  input: { token: string; decision: ConsentDecision; connectionId?: string },
  deps: ConsentDeps = defaultDeps,
): Promise<ConsentDecisionResult> {
  const token = normalizeConnectToken(input.token);
  if (!token) throw new ConsentStepError(404, "consent_invalid");
  const access = await resolveConsentAccess(auth, token, deps);
  if (access.kind !== "ok") throw accessError(access);
  return decideConsent(access.actor, {
    connectionId: input.decision === "approve" ? input.connectionId : undefined,
    decision: input.decision,
    token,
  });
}
