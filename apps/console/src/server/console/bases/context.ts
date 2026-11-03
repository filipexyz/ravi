// Authenticated caller of a Bases operation. Built once per request from the
// auth envelope (Console session, CLI session, Pages viewer session) and
// passed to every service. See `.ravi/specs/console/bases/SPEC.md`
// "Actors And Surfaces".

import type { CliAuthContext } from "@/server/cli/auth";
import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import type { AuthorizationActor } from "../authorization/identity";
import { parseConsoleRole, type ConsoleWorkspace } from "@/server/console/workspace";

import type { BaseViewer } from "./compiler";

export type BasesCallerActorType = "user" | "cli" | "anonymous" | "system";
export type BasesCallerSurface = "console" | "cli" | "page" | "system";
export type BasesCallerSourceKind = "user" | "local_installation" | "pages_session" | "system";

export type BasesCaller = {
  authorization?: AuthorizationActor["delegation"];
  organizationId: string;
  /** Null only for system jobs. `email` is the lowercased primary email. */
  user: { id: string; email: string | null } | null;
  orgRole: string | null;
  actorType: BasesCallerActorType;
  actorId: string | null;
  surface: BasesCallerSurface;
  requestId: string;
  /** Idempotency scope owner. */
  source: { kind: BasesCallerSourceKind; id: string };
  /** Pages site of a `human_viewer` session; null elsewhere. */
  pageSiteId: string | null;
  /** CLI installation; null elsewhere. */
  localInstallationId: string | null;
  /** Untrusted CLI metadata, stored in the ledger only. */
  clientHint: Record<string, unknown> | null;
};

const CLIENT_HINT_KEYS = ["agentId", "sessionKey", "sdk"] as const;
const CLIENT_HINT_MAX_CHARS = 200;

function normalizeEmail(value: string | null | undefined) {
  const trimmed = value?.trim().toLowerCase();
  return trimmed ? trimmed : null;
}

/** Keeps only string `agentId`, `sessionKey`, and `sdk` of at most 200 characters; null when nothing is left. */
export function sanitizeBasesClientHint(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  const hint: Record<string, string> = {};
  for (const key of CLIENT_HINT_KEYS) {
    const value = record[key];
    if (typeof value !== "string") continue;
    const trimmed = value.trim();
    if (!trimmed || trimmed.length > CLIENT_HINT_MAX_CHARS) continue;
    hint[key] = trimmed;
  }
  return Object.keys(hint).length ? hint : null;
}

/** Caller for a Console session request. */
export function basesCallerFromConsoleWorkspace(
  workspace: Pick<ConsoleWorkspace, "mode" | "user" | "organization" | "membership">,
  requestId: string,
): BasesCaller {
  return {
    organizationId: workspace.organization.id,
    user: { id: workspace.user.id, email: normalizeEmail(workspace.user.primaryEmail) },
    orgRole: workspace.membership.role,
    actorType: workspace.mode === "anonymous" ? "anonymous" : "user",
    actorId: workspace.user.id,
    surface: "console",
    requestId,
    source: { kind: "user", id: workspace.user.id },
    pageSiteId: null,
    localInstallationId: null,
    clientHint: null,
  };
}

/** Caller for a CLI session request; `clientHint` is sanitized. */
export function basesCallerFromCliAuth(
  auth: Pick<CliAuthContext, "user" | "organization" | "membership" | "localInstallation" | "cliSession" | "accessTokenJti" | "delegation">,
  requestId: string,
  clientHint?: unknown,
): BasesCaller {
  return {
    authorization: projectAuthorizationFromCli(auth),
    organizationId: auth.organization.id,
    user: { id: auth.user.id, email: normalizeEmail(auth.user.primaryEmail) },
    orgRole: parseConsoleRole(auth.membership.role),
    actorType: "cli",
    actorId: auth.user.id,
    surface: "cli",
    requestId,
    source: { kind: "local_installation", id: auth.localInstallation.id },
    pageSiteId: null,
    localInstallationId: auth.localInstallation.id,
    clientHint: sanitizeBasesClientHint(clientHint),
  };
}

/** Caller for a Ravi Pages `human_viewer` connector exec on `siteId`. */
export function basesCallerForPagesViewer(input: {
  organizationId: string;
  userId: string;
  email: string | null;
  pagesSessionId: string;
  siteId: string;
  orgRole: string | null;
  requestId: string;
}): BasesCaller {
  return {
    organizationId: input.organizationId,
    user: { id: input.userId, email: normalizeEmail(input.email) },
    orgRole: input.orgRole,
    actorType: "user",
    actorId: input.userId,
    surface: "page",
    requestId: input.requestId,
    source: { kind: "pages_session", id: input.pagesSessionId },
    pageSiteId: input.siteId,
    localInstallationId: null,
    clientHint: null,
  };
}

/** Caller for internal jobs. `$viewer.*` never resolves for it. */
export function basesSystemCaller(organizationId: string, requestId: string): BasesCaller {
  return {
    organizationId,
    user: null,
    orgRole: null,
    actorType: "system",
    actorId: null,
    surface: "system",
    requestId,
    source: { kind: "system", id: "system" },
    pageSiteId: null,
    localInstallationId: null,
    clientHint: null,
  };
}

/**
 * The agent a CLI installation says it is writing for (`clientHint.agentId`),
 * recorded next to the accountable human; null for every other caller.
 */
export function basesCallerAgent(caller: BasesCaller): { id: string; installationId: string } | null {
  const agentId = caller.clientHint?.agentId;
  if (!caller.localInstallationId || typeof agentId !== "string" || !agentId) return null;
  return { id: agentId, installationId: caller.localInstallationId };
}

/** `$viewer.*` identity for the compiler; null without a user. */
export function basesCallerViewer(caller: BasesCaller, baseOrganizationId: string): BaseViewer | null {
  if (!caller.user) return null;
  return { raviUserId: caller.user.id, raviOrgId: baseOrganizationId, email: caller.user.email };
}

/** Principal bound into cursors. */
export function basesCallerPrincipal(caller: BasesCaller) {
  return caller.user ? `user:${caller.user.id}` : `${caller.source.kind}:${caller.source.id}`;
}
