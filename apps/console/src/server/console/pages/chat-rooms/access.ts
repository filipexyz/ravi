// Who may be in a chat room. The text chat follows the same doors as the
// Page itself (K7): a member who reads the site's project, or a guest given
// the route (alone or with its site). Never anonymous, never a capture or
// unscoped session. A private room is only its owner's.

import { eq } from "drizzle-orm";

import { canUserViewPagesRoute } from "@/server/console/access/grants";
import { ConsoleApiError } from "@/server/console/api-error";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import {
  findPagesSessionByToken,
  pagesSessionActorKind,
  resolvePagesGuestViewer,
  verifyPagesSessionForSite,
} from "@/server/console/pages/auth";
import { parsePageChatSiteSettings, type PageChatSiteSettings } from "@/server/console/pages/chat/site-settings";
import { requirePageChatEngine } from "../chat/engine";
import { PAGE_CHAT_FEATURE_KEY } from "@/server/console/pages/chat/usage";
import { matchPageRoute, validateRoutePath } from "@/server/console/pages/policy";
import {
  normalizeHostname,
  pagesRouteResolveRepositoryForDb,
  type PagesResolveRoute,
  type PagesResolveSite,
  type PagesRouteResolveRepository,
} from "@/server/console/pages/resolve";
import { db, schema } from "@/server/db";

import type { ChatRoomRecord, ChatRoomStore } from "./store";
import type { ChatViewerRole } from "./types";

export type ChatViewer = {
  userId: string;
  role: ChatViewerRole;
  /** Org role for a member; null for a guest. */
  orgRole: string | null;
  displayName: string;
  email: string | null;
  /** `pages_sessions.id` of the person's session (never the token). */
  pagesSessionId: string;
};

export type ChatSiteContext = {
  site: PagesResolveSite;
  settings: PageChatSiteSettings;
};

export type ChatAccessDeps = {
  routeRepository?: PagesRouteResolveRepository;
  loadSiteMetadata?: (siteId: string) => Promise<unknown>;
  /** The member's org role when the session is a member who reads the site's project. */
  verifyMember?: (input: { host: string; pagesSession: string; requestId: string; site: PagesResolveSite }) => Promise<{ userId: string; orgRole: string } | null>;
  /** A guest's user id when the session belongs to someone outside the org on this site. */
  verifyGuest?: (input: { host: string; pagesSession: string; requestId: string; site: PagesResolveSite }) => Promise<{ userId: string } | null>;
  canGuestViewRoute?: (input: { routeId: string; siteId: string; userId: string }) => Promise<boolean>;
  /** The session record id when it is a `human_viewer` session of the site. */
  humanSessionId?: (pagesSession: string, siteId: string) => Promise<string | null>;
  /** Whether the org has `console.pages.chat` (and, for a member, the role may use it). */
  featureOn?: (input: { organizationId: string; orgRole: string | null }) => Promise<boolean>;
};

/** Resolves the site and its chat settings; refuses when the text chat is off. */
export async function resolveChatSite(host: string, deps: ChatAccessDeps = {}): Promise<ChatSiteContext> {
  requirePageChatEngine();
  const normalized = normalizeHostname(host);
  if (!normalized) throw new ConsoleApiError(400, { error: "payload_invalid" });
  const repository = deps.routeRepository ?? pagesRouteResolveRepositoryForDb();
  const site = await repository.findSiteByHost(normalized);
  if (!site || site.status !== "active") throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  const settings = parsePageChatSiteSettings(await (deps.loadSiteMetadata ?? loadSiteMetadata)(site.id));
  if (!settings.text) throw new ConsoleApiError(403, { error: "chat_disabled_for_site" });
  return { site, settings };
}

/** The active route serving `path` on the site, or null. */
export async function matchChatRoute(site: PagesResolveSite, path: string, deps: ChatAccessDeps = {}): Promise<PagesResolveRoute | null> {
  const repository = deps.routeRepository ?? pagesRouteResolveRepositoryForDb();
  const release = await repository.getActiveRelease(site);
  if (!release || release.status !== "active") return null;
  const routes = await repository.listReleaseRoutes(release.id);
  const normalized = validateRoutePath(path);
  if (!normalized.ok) return null;
  const matched = matchPageRoute(
    routes.map((route) => ({ id: route.id, path: route.path, matchType: route.matchType, priority: route.priority })),
    normalized.path,
  );
  return matched ? (routes.find((route) => route.id === matched.id) ?? null) : null;
}

/**
 * The person behind `pagesSession` on `routeId` of the site, or a refusal:
 * `chat_session_required` (no or unknown session), `chat_forbidden` (signed
 * in but not allowed here), `chat_disabled_for_site` (feature off).
 */
export async function resolveChatViewer(
  input: { host: string; pagesSession: string | null; requestId: string; site: PagesResolveSite; routeId: string },
  store: Pick<ChatRoomStore, "findUserDisplay">,
  deps: ChatAccessDeps = {},
): Promise<ChatViewer> {
  if (!input.pagesSession) throw new ConsoleApiError(401, { error: "chat_session_required" });
  const host = normalizeHostname(input.host) ?? input.host;
  const sessionId = await (deps.humanSessionId ?? defaultHumanSessionId)(input.pagesSession, input.site.id);
  if (!sessionId) throw new ConsoleApiError(401, { error: "chat_session_required" });

  const member = await (deps.verifyMember ?? defaultVerifyMember)({
    host,
    pagesSession: input.pagesSession,
    requestId: input.requestId,
    site: input.site,
  });
  let userId: string;
  let role: ChatViewerRole;
  let orgRole: string | null;
  if (member) {
    userId = member.userId;
    role = "member";
    orgRole = member.orgRole;
  } else {
    const guest = await (deps.verifyGuest ?? defaultVerifyGuest)({
      host,
      pagesSession: input.pagesSession,
      requestId: input.requestId,
      site: input.site,
    });
    if (!guest) throw new ConsoleApiError(401, { error: "chat_session_required" });
    const given = await (deps.canGuestViewRoute ?? canUserViewPagesRoute)({
      routeId: input.routeId,
      siteId: input.site.id,
      userId: guest.userId,
    });
    if (!given) throw new ConsoleApiError(403, { error: "chat_forbidden" });
    userId = guest.userId;
    role = "guest";
    orgRole = null;
  }

  if (!(await (deps.featureOn ?? defaultFeatureOn)({ organizationId: input.site.organizationId, orgRole }))) {
    throw new ConsoleApiError(403, { error: "chat_disabled_for_site" });
  }

  const display = await store.findUserDisplay(userId);
  return {
    userId,
    role,
    orgRole,
    displayName: display?.displayName ?? "Pessoa",
    email: display?.email ?? null,
    pagesSessionId: sessionId,
  };
}

/** A room the viewer may read and write in, loaded by id; the room must belong to the host's site. */
export async function authorizeRoom(
  input: { host: string; pagesSession: string | null; requestId: string; roomId: string },
  store: ChatRoomStore,
  deps: ChatAccessDeps = {},
): Promise<{ room: ChatRoomRecord; viewer: ChatViewer; context: ChatSiteContext }> {
  const context = await resolveChatSite(input.host, deps);
  const room = await store.findRoom(input.roomId);
  if (!room || room.siteId !== context.site.id) throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  const viewer = await resolveChatViewer(
    { host: input.host, pagesSession: input.pagesSession, requestId: input.requestId, site: context.site, routeId: room.routeId },
    store,
    deps,
  );
  if (room.kind === "private" && room.ownerUserId !== viewer.userId) {
    throw new ConsoleApiError(404, { error: "chat_room_not_found" });
  }
  return { room, viewer, context };
}

async function loadSiteMetadata(siteId: string): Promise<unknown> {
  const [row] = await db
    .select({ metadataJson: schema.pageSites.metadataJson })
    .from(schema.pageSites)
    .where(eq(schema.pageSites.id, siteId))
    .limit(1);
  return row?.metadataJson ?? {};
}

async function defaultHumanSessionId(pagesSession: string, siteId: string) {
  const session = await findPagesSessionByToken({ sessionToken: pagesSession });
  if (!session || session.siteId !== siteId || session.status !== "active") return null;
  if (session.expiresAt.getTime() <= Date.now()) return null;
  return pagesSessionActorKind(session) === "human_viewer" ? session.id : null;
}

async function defaultVerifyMember(input: { host: string; pagesSession: string; requestId: string; site: PagesResolveSite }) {
  const workspace = await verifyPagesSessionForSite({
    host: input.host,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site: input.site,
  });
  return workspace ? { userId: workspace.user.id, orgRole: workspace.membership.role } : null;
}

async function defaultVerifyGuest(input: { host: string; pagesSession: string; requestId: string; site: PagesResolveSite }) {
  const guest = await resolvePagesGuestViewer({
    host: input.host,
    requestId: input.requestId,
    sessionToken: input.pagesSession,
    site: input.site,
  });
  return guest ? { userId: guest.userId } : null;
}

async function defaultFeatureOn(input: { organizationId: string; orgRole: string | null }) {
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: input.organizationId,
    role: input.orgRole ?? "owner",
  });
  const feature = access.byKey[PAGE_CHAT_FEATURE_KEY];
  return Boolean(input.orgRole ? feature?.enabled : feature?.available);
}
