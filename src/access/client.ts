/**
 * Console access calls: per-person Pages access, organization invites and
 * access requests (Console spec `console/access`, "CLI Contract").
 *
 *   POST /api/cli/access/pages/share      { url, email, site?, expiresAt?, reason?, actor? }
 *   POST /api/cli/access/pages/unshare    { url, email, site? } | { grantId }; actor?
 *   POST /api/cli/access/pages/access     { url, actor? }
 *   POST /api/cli/access/invites/create   { email, role?, reason?, actor? }
 *   GET  /api/cli/access/invites
 *   POST /api/cli/access/invites/revoke   { inviteId, actor? }
 *   POST /api/cli/access/requests/create  { url, message?, agent?, actor? }
 *   GET  /api/cli/access/requests/<id>
 *
 * Console owns who may share, invite or approve. This side normalizes input,
 * says who wrote the turn (`actor.ts`) and maps Console answers and refusals
 * to the agent contract. The GET routes carry no actor, so they run only on
 * turns where the operator acts, except a request's status, which Console
 * shows only to the installation that made the request.
 */

import { CloudAuthError } from "../cloud-auth/errors.js";
import { createAuthenticatedPagesContext, type PagesClientDeps, type PagesClientOptions } from "../pages/client.js";
import {
  accessActorBody,
  describeAccessActor,
  resolveAccessActor,
  type AccessActorDecision,
  type AccessActorDeps,
  type AccessAgent,
} from "./actor.js";

export const ACCESS_PATHS = {
  share: "/api/cli/access/pages/share",
  unshare: "/api/cli/access/pages/unshare",
  access: "/api/cli/access/pages/access",
  inviteCreate: "/api/cli/access/invites/create",
  invites: "/api/cli/access/invites",
  inviteRevoke: "/api/cli/access/invites/revoke",
  requestCreate: "/api/cli/access/requests/create",
  requests: "/api/cli/access/requests",
} as const;

/** Organization roles, as the Console `organization_role` enum names them. */
export const ORGANIZATION_ROLES = ["viewer", "developer", "admin", "billing", "owner"] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

export const ACCESS_GRANT_MAX_DAYS = 365;
/** What every answer with an approval link says about it. */
export const ACCESS_APPROVAL_LINK_NOTE =
  "Anyone can forward this link; opening it changes nothing, and only the page's managers can approve.";
export const ACCESS_REASON_MAX_CHARS = 500;
export const ACCESS_REQUEST_MESSAGE_MAX_CHARS = 500;
const DAY_MS = 24 * 60 * 60 * 1000;
const INVALID_URL_MESSAGE = "Invalid <url>: pass the Ravi Page link as http(s), without credentials.";
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface AccessDeps extends PagesClientDeps, AccessActorDeps {
  now?: () => Date;
}

export type ActingDecision = Exclude<AccessActorDecision, { kind: "refused" }>;

/** The turn could not be attributed: nothing was sent (exit 3). */
export class AccessActorRefusedError extends Error {
  readonly code = "ACTOR_UNKNOWN";
  constructor(
    message: string,
    readonly actorPrincipal: string,
  ) {
    super(message);
    this.name = "AccessActorRefusedError";
  }
}

/** The turn's actor, or AccessActorRefusedError. Never falls back to the operator. */
export function requireAccessActor(deps: AccessActorDeps = {}): ActingDecision {
  const decision = resolveAccessActor(deps);
  if (decision.kind === "refused") throw new AccessActorRefusedError(decision.message, decision.actorPrincipal);
  return decision;
}

/** GET routes carry no actor: only the operator may read them. */
export function requireOperatorActor(deps: AccessActorDeps, what: string): ActingDecision {
  const decision = requireAccessActor(deps);
  if (decision.kind !== "operator") {
    throw new AccessActorRefusedError(
      `Only the operator can ${what} from here: this turn comes from someone else, and Console cannot check their role on this route.`,
      `contact:${decision.contactId}`,
    );
  }
  return decision;
}

// ---------------------------------------------------------------------------
// Input normalization
// ---------------------------------------------------------------------------

export function normalizeAccessUrl(value: string | undefined): string {
  const raw = value?.trim();
  if (!raw) throw new CloudAuthError("PAYLOAD_INVALID", "Missing <url>. Pass the Ravi Page link.");
  let url: URL;
  try {
    url = new URL(raw.includes("://") ? raw : `https://${raw}`);
  } catch {
    throw new CloudAuthError("PAYLOAD_INVALID", INVALID_URL_MESSAGE);
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password) {
    throw new CloudAuthError("PAYLOAD_INVALID", INVALID_URL_MESSAGE);
  }
  url.hash = "";
  return url.toString();
}

export function normalizeAccessEmail(value: string | undefined, flag = "--with"): string {
  const email = value?.trim().toLowerCase();
  if (!email) throw new CloudAuthError("PAYLOAD_INVALID", `Missing ${flag} <email>.`);
  if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${flag} must be an email address. Received "${email.slice(0, 200)}".`);
  }
  return email;
}

export function normalizeOrganizationRole(value: string | undefined): OrganizationRole | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const role = ORGANIZATION_ROLES.find((candidate) => candidate === normalized);
  if (!role) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--role must be one of ${ORGANIZATION_ROLES.join(", ")}. Received "${value.trim().slice(0, 40)}".`,
    );
  }
  return role;
}

export function normalizeAccessText(value: string | undefined, flag: string, max: number): string | undefined {
  if (value === undefined) return undefined;
  const text = value.trim();
  if (!text) return undefined;
  if (text.length > max) {
    throw new CloudAuthError("PAYLOAD_INVALID", `${flag} must be at most ${max} characters.`);
  }
  return text;
}

/**
 * `--expires`: a duration (`30d`, `12h`, `2w`) or an ISO date or date-time.
 * A date alone means the end of that day (UTC). Must be in the future and at
 * most 365 days out, as Console enforces.
 */
export function normalizeAccessExpiry(value: string | undefined, now: Date = new Date()): string | undefined {
  if (value === undefined) return undefined;
  const raw = value.trim();
  if (!raw) return undefined;
  let at: Date;
  const duration = /^(\d+)\s*([hdw])$/i.exec(raw);
  if (duration) {
    const amount = Number(duration[1]);
    const unit = (duration[2] ?? "d").toLowerCase();
    const ms = unit === "h" ? 60 * 60 * 1000 : unit === "w" ? 7 * DAY_MS : DAY_MS;
    at = new Date(now.getTime() + amount * ms);
  } else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    at = new Date(`${raw}T23:59:59.000Z`);
  } else if (/^\d{4}-\d{2}-\d{2}T/.test(raw)) {
    at = new Date(raw);
  } else {
    at = new Date(Number.NaN);
  }
  if (Number.isNaN(at.getTime())) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--expires must be a duration such as 30d, 12h or 2w, or an ISO date such as 2026-12-31. Received "${raw.slice(0, 60)}".`,
    );
  }
  if (at.getTime() <= now.getTime() || at.getTime() > now.getTime() + ACCESS_GRANT_MAX_DAYS * DAY_MS) {
    throw new CloudAuthError(
      "PAYLOAD_INVALID",
      `--expires must be in the future and at most ${ACCESS_GRANT_MAX_DAYS} days from now.`,
    );
  }
  return at.toISOString();
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface AccessGrant {
  id: string;
  email: string;
  name: string | null;
  userId: string;
  scope: "route" | "site";
  routeId: string | null;
  routePath: string | null;
  url: string;
  expiresAt: string | null;
  createdAt: string;
  createdBy: string | null;
}

export interface OrganizationInvite {
  id: string;
  email: string;
  role: string;
  createdAt: string;
  expiresAt: string;
  invitedBy: string | null;
}

export interface AccessRequest {
  id: string;
  status: string;
  url: string;
  path: string;
  host: string;
  createdAt: string;
  expiresAt: string | null;
  decidedAt: string | null;
}

export type ActedBy = { kind: "operator" } | { kind: "contact"; contactId: string };

export interface PagesShareResult {
  success: true;
  consoleUrl: string;
  actedBy: ActedBy;
  created: boolean;
  userCreated: boolean;
  grant: AccessGrant;
}

export interface PagesUnshareResult {
  success: true;
  consoleUrl: string;
  actedBy: ActedBy;
  revoked: boolean;
}

export interface PagesAccessResult {
  success: true;
  consoleUrl: string;
  actedBy: ActedBy;
  site: { id: string; host: string };
  total: number;
  grants: AccessGrant[];
}

export interface InviteCreateResult {
  success: true;
  consoleUrl: string;
  actedBy: ActedBy;
  invite: OrganizationInvite;
  url: string;
}

export interface InviteListResult {
  success: true;
  consoleUrl: string;
  total: number;
  invites: OrganizationInvite[];
}

export interface InviteRevokeResult {
  success: true;
  consoleUrl: string;
  actedBy: ActedBy;
  revoked: boolean;
}

export type AccessRequestCreateResult =
  | {
      success: true;
      consoleUrl: string;
      actedBy: ActedBy;
      status: "requested";
      request: AccessRequest;
      approvalUrl: string;
      approvalNote: string;
    }
  | {
      success: true;
      consoleUrl: string;
      actedBy: ActedBy;
      status: "already_allowed";
      url: string;
    };

export interface AccessRequestStatusResult {
  success: true;
  consoleUrl: string;
  request: AccessRequest;
  approvalUrl: string;
  approvalNote: string;
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface PagesShareOptions extends PagesClientOptions {
  url: string;
  email: string;
  site?: boolean;
  expiresAt?: string;
  reason?: string;
}

/** The request body for a share: what the dry-run shows and `--execute` sends. */
export function buildShareBody(options: PagesShareOptions, actor: ActingDecision): Record<string, unknown> {
  return {
    url: normalizeAccessUrl(options.url),
    email: normalizeAccessEmail(options.email),
    ...(options.site ? { site: true } : {}),
    ...(options.expiresAt ? { expiresAt: options.expiresAt } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...accessActorBody(actor),
  };
}

/**
 * The dry-run plan for a braked call: the body that `--execute` sends, with
 * the page URL under `page` (plan keys ending in `url` are cut to the origin
 * by the public redaction) and who will act instead of the raw actor field.
 */
export function accessDryRunPlan(
  body: Record<string, unknown>,
  actor: ActingDecision,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  const { actor: _actor, url, ...rest } = body;
  return { ...(typeof url === "string" ? { page: url } : {}), ...rest, ...extra, actingAs: describeAccessActor(actor) };
}

export async function sharePageAccess(options: PagesShareOptions, deps: AccessDeps = {}): Promise<PagesShareResult> {
  const actor = requireAccessActor(deps);
  const body = buildShareBody(options, actor);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("POST", ACCESS_PATHS.share, body, context.accessToken),
  );
  return {
    success: true,
    consoleUrl: context.consoleUrl,
    actedBy: actedBy(actor),
    created: payload.created === true,
    userCreated: payload.userCreated === true,
    grant: normalizeGrant(payload.grant),
  };
}

export type PagesUnshareOptions = PagesClientOptions &
  ({ grantId: string } | { url: string; email: string; site?: boolean });

export function buildUnshareBody(options: PagesUnshareOptions, actor: ActingDecision): Record<string, unknown> {
  if ("grantId" in options) {
    const grantId = options.grantId.trim();
    if (!grantId) throw new CloudAuthError("PAYLOAD_INVALID", "Missing --grant <id>.");
    return { grantId, ...accessActorBody(actor) };
  }
  return {
    url: normalizeAccessUrl(options.url),
    email: normalizeAccessEmail(options.email),
    ...(options.site ? { site: true } : {}),
    ...accessActorBody(actor),
  };
}

export async function unsharePageAccess(
  options: PagesUnshareOptions,
  deps: AccessDeps = {},
): Promise<PagesUnshareResult> {
  const actor = requireAccessActor(deps);
  const body = buildUnshareBody(options, actor);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("POST", ACCESS_PATHS.unshare, body, context.accessToken),
  );
  return { success: true, consoleUrl: context.consoleUrl, actedBy: actedBy(actor), revoked: payload.revoked === true };
}

export async function listPageAccess(
  options: PagesClientOptions & { url: string },
  deps: AccessDeps = {},
): Promise<PagesAccessResult> {
  const actor = requireAccessActor(deps);
  const body = { url: normalizeAccessUrl(options.url), ...accessActorBody(actor) };
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("POST", ACCESS_PATHS.access, body, context.accessToken),
  );
  const site = record(payload.site);
  const grants = array(payload.grants).map(normalizeGrant);
  return {
    success: true,
    consoleUrl: context.consoleUrl,
    actedBy: actedBy(actor),
    site: { id: text(site.id), host: text(site.host) },
    total: grants.length,
    grants,
  };
}

export interface InviteCreateOptions extends PagesClientOptions {
  email: string;
  role?: OrganizationRole;
  reason?: string;
}

export function buildInviteBody(options: InviteCreateOptions, actor: ActingDecision): Record<string, unknown> {
  return {
    email: normalizeAccessEmail(options.email, "--email"),
    ...(options.role ? { role: options.role } : {}),
    ...(options.reason ? { reason: options.reason } : {}),
    ...accessActorBody(actor),
  };
}

export async function createInvite(options: InviteCreateOptions, deps: AccessDeps = {}): Promise<InviteCreateResult> {
  const actor = requireAccessActor(deps);
  const body = buildInviteBody(options, actor);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("POST", ACCESS_PATHS.inviteCreate, body, context.accessToken),
  );
  const url = text(payload.url);
  if (!url) throw new CloudAuthError("SERVER_UNAVAILABLE", "Console created the invite but returned no invite URL.");
  return {
    success: true,
    consoleUrl: context.consoleUrl,
    actedBy: actedBy(actor),
    invite: normalizeInvite(payload.invite),
    url,
  };
}

export async function listInvites(options: PagesClientOptions = {}, deps: AccessDeps = {}): Promise<InviteListResult> {
  requireOperatorActor(deps, "list the organization's invites");
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("GET", ACCESS_PATHS.invites, undefined, context.accessToken),
  );
  const invites = array(payload.invites).map(normalizeInvite);
  return { success: true, consoleUrl: context.consoleUrl, total: invites.length, invites };
}

export async function revokeInvite(
  options: PagesClientOptions & { inviteId: string },
  deps: AccessDeps = {},
): Promise<InviteRevokeResult> {
  const inviteId = options.inviteId?.trim();
  if (!inviteId) throw new CloudAuthError("PAYLOAD_INVALID", "Missing <invite-id>. List them with: ravi invites list");
  const actor = requireAccessActor(deps);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>(
      "POST",
      ACCESS_PATHS.inviteRevoke,
      { inviteId, ...accessActorBody(actor) },
      context.accessToken,
    ),
  );
  return { success: true, consoleUrl: context.consoleUrl, actedBy: actedBy(actor), revoked: payload.revoked === true };
}

export interface AccessRequestOptions extends PagesClientOptions {
  url: string;
  message?: string;
}

export function buildAccessRequestBody(options: AccessRequestOptions, actor: ActingDecision): Record<string, unknown> {
  return {
    url: normalizeAccessUrl(options.url),
    ...(options.message ? { message: options.message } : {}),
    ...(actor.agent ? { agent: agentBody(actor.agent) } : {}),
    ...accessActorBody(actor),
  };
}

export async function createAccessRequest(
  options: AccessRequestOptions,
  deps: AccessDeps = {},
): Promise<AccessRequestCreateResult> {
  const actor = requireAccessActor(deps);
  const body = buildAccessRequestBody(options, actor);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>("POST", ACCESS_PATHS.requestCreate, body, context.accessToken),
  );
  if (payload.status === "already_allowed") {
    return {
      success: true,
      consoleUrl: context.consoleUrl,
      actedBy: actedBy(actor),
      status: "already_allowed",
      url: text(payload.url) || text(body.url),
    };
  }
  const request = normalizeRequest(payload.request);
  if (!request.id) throw new CloudAuthError("SERVER_UNAVAILABLE", "Console answered without the access request.");
  return {
    success: true,
    consoleUrl: context.consoleUrl,
    actedBy: actedBy(actor),
    status: "requested",
    request,
    approvalUrl: approvalUrl(context.consoleUrl, request.id, payload),
    approvalNote: ACCESS_APPROVAL_LINK_NOTE,
  };
}

export async function getAccessRequest(
  options: PagesClientOptions & { requestId: string },
  deps: AccessDeps = {},
): Promise<AccessRequestStatusResult> {
  const requestId = options.requestId?.trim();
  if (!requestId || !/^[A-Za-z0-9_-]{1,128}$/.test(requestId)) {
    throw new CloudAuthError("PAYLOAD_INVALID", "Invalid <request-id>: pass the id that ravi access request printed.");
  }
  // Console shows a request only to the installation that made it (or its
  // requester), so any attributable turn of this installation may read it.
  requireAccessActor(deps);
  const context = await createAuthenticatedPagesContext(options, deps);
  const payload = record(
    await context.client.requestJson<unknown>(
      "GET",
      `${ACCESS_PATHS.requests}/${encodeURIComponent(requestId)}`,
      undefined,
      context.accessToken,
    ),
  );
  const request = normalizeRequest(payload.request);
  return {
    success: true,
    consoleUrl: context.consoleUrl,
    request,
    approvalUrl: approvalUrl(context.consoleUrl, request.id || requestId, payload),
    approvalNote: ACCESS_APPROVAL_LINK_NOTE,
  };
}

// ---------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------

export type AccessOperation =
  | "pages share"
  | "pages unshare"
  | "pages access"
  | "invites create"
  | "invites list"
  | "invites revoke"
  | "access request"
  | "access status";

export interface AccessFailure {
  code: string;
  message: string;
  exitCode: 1 | 3;
  details: Record<string, unknown>;
}

/** Console refusals and local actor refusals, as the agent-facing failure. */
export function describeAccessFailure(error: unknown, op: AccessOperation): AccessFailure | null {
  if (error instanceof AccessActorRefusedError) {
    return {
      code: error.code,
      message: error.message,
      exitCode: 3,
      details: {
        suggestedAction:
          "do not retry from this turn; the person can ask from their own chat, or the operator can run the command in the terminal",
      },
    };
  }
  if (!(error instanceof CloudAuthError)) return null;
  const reason = typeof error.details?.reason === "string" ? error.details.reason : undefined;
  const withReason = (details: Record<string, unknown>) => (reason ? { reason, ...details } : details);
  switch (error.code) {
    case "ACTOR_NOT_LINKED":
      return {
        code: "ACTOR_NOT_LINKED",
        message:
          "The person asking has no Console link on this Ravi, so Console cannot act for them. Run `ravi link` in their chat: they approve a private link, then ask again.",
        exitCode: 3,
        details: { suggestedAction: "run `ravi link` from the person's own chat turn, then retry the same command" },
      };
    case "PROJECT_ACCESS_DENIED":
      return {
        code: "PROJECT_ACCESS_DENIED",
        message: projectDeniedMessage(op),
        exitCode: 1,
        details: withReason({
          suggestedAction:
            op === "invites create" || op === "invites list" || op === "invites revoke"
              ? "ask an organization owner or admin to do it"
              : "ask someone who can publish to the page's project to do it",
        }),
      };
    case "ORG_ACCESS_DENIED":
      if (op === "pages share" || op === "pages unshare" || op === "pages access") {
        return {
          code: "ORG_ACCESS_DENIED",
          message:
            "This page belongs to another organization than the current ravi login, so its access cannot be managed from here.",
          exitCode: 1,
          details: withReason({
            suggestedAction: "to see it yourself, ask its managers with: ravi access request <url>",
          }),
        };
      }
      return null;
    case "NOT_FOUND":
      return { code: "NOT_FOUND", message: notFoundMessage(op, reason), exitCode: 1, details: withReason({}) };
    case "CONFLICT":
      if (op === "invites create") {
        return {
          code: "CONFLICT",
          message: "That email already belongs to an active member of the organization.",
          exitCode: 1,
          details: withReason({ suggestedAction: "do not invite them again; they already have access" }),
        };
      }
      return null;
    default:
      return null;
  }
}

function projectDeniedMessage(op: AccessOperation): string {
  switch (op) {
    case "invites create":
    case "invites list":
    case "invites revoke":
      return "Only an organization owner or admin can manage invites, and only an owner can invite an owner. The ravi login user (or the person asking) does not have that role.";
    case "access request":
    case "access status":
      return "Console refused this access request for the current login.";
    default:
      return "Only people who can publish to the page's project (organization owner, admin or developer, or a project admin or developer) can manage who sees it. The ravi login user (or the person asking) cannot.";
  }
}

function notFoundMessage(op: AccessOperation, reason: string | undefined): string {
  if (reason === "route_not_found") {
    return "No route of the live release matches that URL's path. Check it with `ravi pages published --json`, or pass --site for the whole site.";
  }
  switch (op) {
    case "pages share":
    case "pages access":
      return "No published Ravi Page answers at that URL. Check the link; list live URLs with `ravi pages published --json`.";
    case "pages unshare":
      return "No such page or grant. List who has access with `ravi pages access <url>`.";
    case "invites revoke":
      return "No pending invite with that id. List them with `ravi invites list`.";
    case "access status":
      return "No access request with that id made from this Ravi.";
    case "access request":
      return "No published Ravi Page answers at that URL.";
    default:
      return "Console resource was not found.";
  }
}

// ---------------------------------------------------------------------------
// Normalization helpers
// ---------------------------------------------------------------------------

function actedBy(actor: ActingDecision): ActedBy {
  return actor.kind === "contact" ? { kind: "contact", contactId: actor.contactId } : { kind: "operator" };
}

function agentBody(agent: AccessAgent): { id: string; name?: string } {
  return { id: agent.id, ...(agent.name ? { name: agent.name } : {}) };
}

/** Console's own link (`request.url`, https only), else `<console>/access/requests/<id>`. */
function approvalUrl(consoleUrl: string, requestId: string, payload: Record<string, unknown>): string {
  const request = record(payload.request);
  const given = text(request.url) || text(payload.approvalUrl) || text(request.approvalUrl);
  if (given.startsWith("https://")) return given;
  return `${consoleUrl.replace(/\/+$/, "")}/access/requests/${encodeURIComponent(requestId)}`;
}

function normalizeGrant(value: unknown): AccessGrant {
  const grant = record(value);
  return {
    id: text(grant.id),
    email: text(grant.email),
    name: nullableText(grant.name),
    userId: text(grant.userId),
    scope: grant.scope === "site" ? "site" : "route",
    routeId: nullableText(grant.routeId),
    routePath: nullableText(grant.routePath),
    url: text(grant.url),
    expiresAt: nullableText(grant.expiresAt),
    createdAt: text(grant.createdAt),
    createdBy: nullableText(grant.createdBy),
  };
}

function normalizeInvite(value: unknown): OrganizationInvite {
  const invite = record(value);
  return {
    id: text(invite.id),
    email: text(invite.email),
    role: text(invite.role),
    createdAt: text(invite.createdAt),
    expiresAt: text(invite.expiresAt),
    invitedBy: nullableText(invite.invitedBy),
  };
}

function normalizeRequest(value: unknown): AccessRequest {
  const request = record(value);
  return {
    id: text(request.id),
    status: text(request.status),
    /** The forwardable approval link, not the page. */
    url: text(request.url),
    path: text(request.path),
    host: text(request.host),
    createdAt: text(request.createdAt),
    expiresAt: nullableText(request.expiresAt),
    decidedAt: nullableText(request.decidedAt),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function nullableText(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}
