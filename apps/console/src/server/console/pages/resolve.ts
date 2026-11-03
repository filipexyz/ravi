import { and, desc, eq, inArray, or } from "drizzle-orm";

import { db, schema } from "@/server/db";
import {
  findPageRouteConflicts,
  matchPageRoute,
  pageRouteSpaFallbackApplies,
  validateManifestFilePath,
  validateRoutePath,
  type PageRouteMatchType,
} from "./policy";
import type { PageVisibility } from "../pages";
import { canUserViewPagesRoute } from "../access/grants";
import { type PagesAuthSite, verifyPagesGuestSessionForRoute, verifyPagesSessionForSite } from "./auth";
import { verifyPagesPasswordSessionForRoute } from "./password-access";
import { isFinalObjectKeyForArtifact } from "./storage-keys";
import { parsePageChatSiteSettings } from "./chat/site-settings";
import { pageChatEngineEnabled } from "./chat/engine";
import { getConsoleFeatureAccessForOrganizationRole } from "../feature-access";
import { markHasAudience, readActiveRouteMark } from "../knowledge/marks";

export {
  getPagesControlToken as getPagesResolveControlToken,
  isPagesControlRequestAuthorized as authorizePagesResolveRequest,
} from "./auth";

export type PagesRouteResolveRequest = {
  host: string;
  path: string;
  search?: string | null;
  method?: string;
  pagesSession?: string | null;
  pagesPasswordSession?: string | null;
  requestId?: string | null;
};

export type PagesRouteResolveStatus = "ok" | "redirect" | "not_found" | "private" | "password_required" | "error";
export type PagesRouteCacheMode = "immutable" | "entrypoint" | "private" | "no-store";

export type PagesRouteResolveOkResponse = {
  status: "ok";
  httpStatus: 200;
  site: {
    id: string;
    organizationId: string;
    projectId: string;
    visibility: PageVisibility;
  };
  release: {
    id: string;
    number: number;
  };
  route: {
    id: string;
    bindingId: string;
    path: string;
    matchType: PageRouteMatchType;
    visibility: PageVisibility;
    browserPermissions?: {
      deviceMotion: "self";
    };
  };
  artifact: {
    id: string;
    versionId: string;
    versionNumber: number;
    entrypoint: string;
    assetBase: string;
    sha256: string | null;
  };
  object: {
    path: string;
    assetId: string;
    r2Key: string;
    contentType: string;
    cache: PagesRouteCacheMode;
    etag: string | null;
    sha256: string | null;
    sizeBytes: number | null;
  };
  cache: {
    mode: PagesRouteCacheMode;
    control: string;
  };
  headers: Record<string, string>;
  toolbar?: {
    enabled: true;
    host: string;
    path: string;
    effectiveVisibility: PageVisibility;
    siteId: string;
    projectId: string;
    routeId: string;
    releaseId: string;
    releaseNumber: number;
    artifactId: string;
    artifactVersionId: string;
    artifactVersionNumber: number;
    /** Present when this viewer may open Page Chat on this HTML response. */
    pageChat?: {
      enabled: true;
    };
  };
  /**
   * Present for a guest (someone outside the org given this page) on an HTML
   * route marked for page viewers, when Page Chat is on for the site. The
   * guest gets a "talk" button only; `toolbar` stays absent.
   */
  guestChat?: {
    enabled: true;
  };
};

export type PagesRouteResolveStateResponse = {
  status: Exclude<PagesRouteResolveStatus, "ok">;
  httpStatus: 302 | 308 | 401 | 404 | 405 | 503;
  code: string;
  headers: Record<string, string>;
  redirect?: {
    location: string;
  };
};

export type PagesRouteResolveResponse = PagesRouteResolveOkResponse | PagesRouteResolveStateResponse;

export type PagesResolveSite = {
  id: string;
  organizationId: string;
  projectId: string;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  activeReleaseId: string | null;
  status: "active" | "disabled" | "deleted";
  customDomain?: {
    hostname: string;
    mode: "redirect" | "serve";
    redirectToHostname?: string | null;
  };
};

export type PagesResolveRelease = {
  id: string;
  releaseNumber: number;
  status: "draft" | "active" | "archived" | "failed";
};

export type PagesResolveRoute = {
  id: string;
  routeId: string;
  path: string;
  matchType: PageRouteMatchType;
  priority: number;
  artifactId: string;
  artifactVersionId: string;
  entrypoint: string;
  assetBase: string;
  visibility: PageVisibility;
  routeConfigJson?: Record<string, unknown>;
};

export type PagesResolveFile = {
  artifactStatus: "active" | "archived" | "deleted";
  versionStatus: "created" | "building" | "ready" | "failed" | "archived";
  versionNumber: number;
  versionSha256: string | null;
  assetId: string;
  path: string;
  mimeType: string | null;
  sizeBytes: number | null;
  sha256: string | null;
  storageJson: Record<string, unknown>;
};

export type PagesRouteResolveRepository = {
  findSiteByHost(host: string): Promise<PagesResolveSite | null>;
  getActiveRelease(site: PagesResolveSite): Promise<PagesResolveRelease | null>;
  listReleaseRoutes(releaseId: string): Promise<PagesResolveRoute[]>;
  getArtifactVersionFile(input: {
    artifactId: string;
    artifactVersionId: string;
    path: string;
  }): Promise<PagesResolveFile | null>;
};

export type PagesPrivateAccessVerifier = (input: {
  host: string;
  pagesSession: string | null | undefined;
  requestId: string | null | undefined;
  site: PagesResolveSite;
}) => Promise<boolean>;

/** Whether someone outside the org was given access to this route (a guest). */
export type PagesGuestAccessVerifier = (input: {
  host: string;
  pagesSession: string | null | undefined;
  requestId: string | null | undefined;
  routeId: string;
  site: PagesResolveSite;
}) => Promise<boolean>;

/** Whether Page Chat is offered on this site: the org feature is on and the site did not turn it off. */
export type PagesPageChatAvailability = (site: PagesResolveSite) => Promise<boolean>;

/** Whether the route (`page_routes.id`) has an active mark for page viewers. Read from `page_routes`, never a release copy. */
export type PagesGuestChatMark = (routeId: string) => Promise<boolean>;

export type PagesPasswordAccessVerifier = (input: {
  host: string;
  pagesPasswordSession: string | null | undefined;
  requestId: string | null | undefined;
  routeId: string;
  routeVisibility: PageVisibility;
  site: PagesResolveSite;
}) => Promise<boolean>;

import { hostedPagesDomain } from "@/server/console/pages/hosted-domain";
const RESERVED_ASSET_PREFIX = "/_ravi/assets/";
const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable";
const ENTRYPOINT_CACHE_CONTROL = "public, max-age=0, must-revalidate";
const NO_STORE_CACHE_CONTROL = "no-store";

type DbExecutor = Pick<typeof db, "select">;

export function pagesRouteResolveRepositoryForDb(database: DbExecutor = db): PagesRouteResolveRepository {
  return {
    async findSiteByHost(host) {
      const normalizedHost = normalizeHostname(host);
      if (!normalizedHost) return null;

      const hostedSlug = hostedSlugFromHost(normalizedHost);
      const hostPredicate = hostedSlug
        ? or(eq(schema.pageSites.defaultHostname, normalizedHost), eq(schema.pageSites.slug, hostedSlug))
        : eq(schema.pageSites.defaultHostname, normalizedHost);

      const [site] = await database
        .select()
        .from(schema.pageSites)
        .where(and(hostPredicate, eq(schema.pageSites.status, "active")))
        .limit(1);

      if (site) return site;

      const exactCustomHostnameSite = await findCustomHostnameSite(database, normalizedHost);
      if (exactCustomHostnameSite) return exactCustomHostnameSite;

      const wildcardHostnames = wildcardHostnamesForHost(normalizedHost);
      if (wildcardHostnames.length === 0) return null;

      const wildcardCustomHostnameSites = await findCustomHostnameSites(database, wildcardHostnames);
      const [wildcardCustomHostnameSite] = wildcardCustomHostnameSites.sort(
        (left, right) =>
          wildcardHostnames.indexOf(left.customDomain?.hostname ?? "") -
          wildcardHostnames.indexOf(right.customDomain?.hostname ?? ""),
      );

      return wildcardCustomHostnameSite ?? null;
    },

    async getActiveRelease(site) {
      if (!site.activeReleaseId) return null;

      const [release] = await database
        .select()
        .from(schema.pageSiteReleases)
        .where(
          and(
            eq(schema.pageSiteReleases.id, site.activeReleaseId),
            eq(schema.pageSiteReleases.siteId, site.id),
            eq(schema.pageSiteReleases.status, "active"),
          ),
        )
        .limit(1);

      return release ?? null;
    },

    async listReleaseRoutes(releaseId) {
      return database
        .select()
        .from(schema.pageReleaseRoutes)
        .where(eq(schema.pageReleaseRoutes.releaseId, releaseId))
        .orderBy(desc(schema.pageReleaseRoutes.priority), desc(schema.pageReleaseRoutes.path));
    },

    async getArtifactVersionFile(input) {
      const [file] = await database
        .select({
          artifactStatus: schema.artifacts.status,
          versionStatus: schema.artifactVersions.status,
          versionNumber: schema.artifactVersions.versionNumber,
          versionSha256: schema.artifactVersions.sha256,
          assetId: schema.assets.id,
          path: schema.assets.path,
          mimeType: schema.assets.mimeType,
          sizeBytes: schema.assets.sizeBytes,
          sha256: schema.assets.sha256,
          storageJson: schema.assets.storageJson,
        })
        .from(schema.assets)
        .innerJoin(schema.artifacts, eq(schema.assets.artifactId, schema.artifacts.id))
        .innerJoin(schema.artifactVersions, eq(schema.assets.artifactVersionId, schema.artifactVersions.id))
        .where(
          and(
            eq(schema.assets.artifactId, input.artifactId),
            eq(schema.assets.artifactVersionId, input.artifactVersionId),
            eq(schema.assets.path, input.path),
          ),
        )
        .limit(1);

      return file ?? null;
    },
  };
}

async function findCustomHostnameSite(database: DbExecutor, hostname: string) {
  const [row] = await findCustomHostnameSites(database, [hostname]);
  return row ?? null;
}

async function findCustomHostnameSites(database: DbExecutor, hostnames: string[]) {
  if (hostnames.length === 0) return [];

  const rows = await database
        .select({
          activeReleaseId: schema.pageSites.activeReleaseId,
          bindingHostname: schema.pageDomainBindings.hostname,
          claimDomain: schema.domainClaims.normalizedDomain,
          defaultHostname: schema.pageSites.defaultHostname,
          defaultVisibility: schema.pageSites.defaultVisibility,
          id: schema.pageSites.id,
          organizationId: schema.pageSites.organizationId,
          policyJson: schema.domainBindings.policyJson,
          projectId: schema.pageSites.projectId,
          status: schema.pageSites.status,
        })
        .from(schema.pageDomainBindings)
        .innerJoin(schema.domainBindings, eq(schema.pageDomainBindings.domainBindingId, schema.domainBindings.id))
        .innerJoin(schema.domainClaims, eq(schema.domainBindings.domainClaimId, schema.domainClaims.id))
        .innerJoin(schema.pageSites, eq(schema.pageDomainBindings.pageSiteId, schema.pageSites.id))
        .where(
          and(
            inArray(schema.pageDomainBindings.hostname, hostnames),
            eq(schema.domainBindings.product, "pages"),
            eq(schema.domainBindings.status, "active"),
            eq(schema.pageSites.status, "active"),
          ),
        );

  return rows.map((row) => pageResolveSiteFromCustomHostnameRow(row));
}

function pageResolveSiteFromCustomHostnameRow(row: {
  activeReleaseId: string | null;
  bindingHostname: string;
  claimDomain: string;
  defaultHostname: string;
  defaultVisibility: PageVisibility;
  id: string;
  organizationId: string;
  policyJson: Record<string, unknown>;
  projectId: string;
  status: "active" | "disabled" | "deleted";
}): PagesResolveSite {
  const policy = record(row.policyJson);
  const explicitMode = policy.mode === "redirect" || policy.mode === "serve" ? policy.mode : null;
  const inferredMode = row.bindingHostname === row.claimDomain ? "redirect" : "serve";
  const mode = explicitMode ?? inferredMode;
  const redirectToHostname =
    typeof policy.redirectToHostname === "string"
      ? policy.redirectToHostname
      : mode === "redirect"
        ? `www.${row.claimDomain}`
        : null;

  return {
    activeReleaseId: row.activeReleaseId,
    customDomain: {
      hostname: row.bindingHostname,
      mode,
      redirectToHostname,
    },
    defaultHostname: row.defaultHostname,
    defaultVisibility: row.defaultVisibility,
    id: row.id,
    organizationId: row.organizationId,
    projectId: row.projectId,
    status: row.status,
  };
}

export async function resolvePagesRoute({
  guestAccessVerifier = canGuestViewRoute,
  guestChatMark = routeMarkedForPageViewers,
  input,
  pageChatAvailability = isPageChatAvailableForSite,
  passwordAccessVerifier = canViewPasswordRoute,
  privateAccessVerifier = canViewPrivateRoute,
  repository = pagesRouteResolveRepositoryForDb(),
}: {
  guestAccessVerifier?: PagesGuestAccessVerifier;
  guestChatMark?: PagesGuestChatMark;
  input: PagesRouteResolveRequest;
  pageChatAvailability?: PagesPageChatAvailability;
  passwordAccessVerifier?: PagesPasswordAccessVerifier;
  privateAccessVerifier?: PagesPrivateAccessVerifier;
  repository?: PagesRouteResolveRepository;
}): Promise<PagesRouteResolveResponse> {
  const method = input.method?.toUpperCase() ?? "GET";
  if (method !== "GET" && method !== "HEAD") {
    return stateResponse("error", 405, "method_not_allowed");
  }

  const host = normalizeHostname(input.host);
  if (!host) return notFound();

  const site = await repository.findSiteByHost(host);
  if (!site || site.status !== "active") return notFound();
  if (site.customDomain?.mode === "redirect") {
    return redirectResponse(site.customDomain.redirectToHostname, input.path, input.search);
  }

  const release = await repository.getActiveRelease(site);
  if (!release || release.status !== "active") return notFound();

  const routes = await repository.listReleaseRoutes(release.id);
  const routeDefinitions = routes.map((route) => ({
    id: route.id,
    path: route.path,
    matchType: route.matchType,
    priority: route.priority,
  }));

  if (findPageRouteConflicts(routeDefinitions).length > 0) {
    return stateResponse("error", 503, "active_release_route_conflict");
  }

  const reservedAssetPath = parseReservedAssetPath(input.path);
  if (reservedAssetPath) {
    return resolveReservedAsset({
      assetPath: reservedAssetPath,
      guestAccessVerifier,
      host,
      repository,
      release,
      routes,
      site,
      pagesSession: input.pagesSession,
      pagesPasswordSession: input.pagesPasswordSession,
      passwordAccessVerifier,
      privateAccessVerifier,
      requestId: input.requestId ?? null,
    });
  }

  const normalizedPath = validateRoutePath(input.path);
  if (!normalizedPath.ok) return notFound();

  const matchedDefinition = matchPageRoute(routeDefinitions, normalizedPath.path);
  const route = matchedDefinition ? routes.find((candidate) => candidate.id === matchedDefinition.id) : null;
  if (!route) return notFound();

  const visibility = effectiveVisibility(site.defaultVisibility, route.visibility);
  const operatorCanAccess = input.pagesSession
    ? await privateAccessVerifier({
        host,
        pagesSession: input.pagesSession,
        requestId: input.requestId,
        site,
      })
    : false;
  const passwordCanAccess =
    visibility === "password" && !operatorCanAccess
      ? await passwordAccessVerifier({
          host,
          pagesPasswordSession: input.pagesPasswordSession,
          requestId: input.requestId,
          routeId: route.routeId,
          routeVisibility: route.visibility,
          site,
        })
      : false;
  if (visibility === "password" && !operatorCanAccess && !passwordCanAccess) {
    return passwordRequiredResponse();
  }
  // Someone outside the org sees a private page only with access given to them
  // for it; they get the page alone, without the Pages bar or Page Chat.
  const guestCanAccess =
    isGuestShareableVisibility(visibility) && !operatorCanAccess && input.pagesSession
      ? await guestAccessVerifier({
          host,
          pagesSession: input.pagesSession,
          requestId: input.requestId,
          routeId: route.routeId,
          site,
        })
      : false;
  if (visibility !== "public" && visibility !== "password" && !operatorCanAccess && !guestCanAccess) {
    return privateResponse();
  }

  const requestedArtifactPath = artifactPathForRequest(route, normalizedPath.path);
  if (!requestedArtifactPath) return notFound();

  const requestedFile = await repository.getArtifactVersionFile({
    artifactId: route.artifactId,
    artifactVersionId: route.artifactVersionId,
    path: requestedArtifactPath,
  });

  const file =
    requestedFile ??
    (pageRouteSpaFallbackApplies(route) && requestedArtifactPath !== route.entrypoint
      ? await repository.getArtifactVersionFile({
          artifactId: route.artifactId,
          artifactVersionId: route.artifactVersionId,
          path: route.entrypoint,
        })
      : null);

  if (!file || file.artifactStatus !== "active" || file.versionStatus !== "ready") return notFound();

  // Page Chat rides the Pages bar, so it is offered only where the bar is: a
  // signed-in viewer with access, on an HTML document.
  const pageChat =
    operatorCanAccess && isHtmlFile(file) ? await pageChatAvailabilitySafe(pageChatAvailability, site) : false;
  // A guest may talk only on an HTML route the org marked for page viewers.
  // The release row never carries the mark, so it is read by route id.
  const guestChat =
    guestCanAccess && isHtmlFile(file)
      ? (await pageChatAvailabilitySafe(pageChatAvailability, site)) && (await guestChatMarkSafe(guestChatMark, route.routeId))
      : false;

  return resolvedFileResponse({
    file,
    guestChat,
    host,
    pageChat,
    release,
    route,
    site,
    toolbarVisibility: operatorCanAccess ? visibility : null,
  });
}

async function pageChatAvailabilitySafe(check: PagesPageChatAvailability, site: PagesResolveSite) {
  if (!pageChatEngineEnabled()) return false;
  try {
    return await check(site);
  } catch (error) {
    // Page Chat must never break serving the page itself.
    console.error("Page Chat availability check failed", { error, siteId: site.id });
    return false;
  }
}

async function guestChatMarkSafe(check: PagesGuestChatMark, routeId: string) {
  try {
    return await check(routeId);
  } catch (error) {
    console.error("Page Chat guest mark check failed", { error, routeId });
    return false;
  }
}

async function routeMarkedForPageViewers(routeId: string) {
  const mark = await readActiveRouteMark(routeId);
  return Boolean(mark && markHasAudience(mark, { kind: "page_viewers" }));
}

async function isPageChatAvailableForSite(site: PagesResolveSite) {
  const [access, [row]] = await Promise.all([
    getConsoleFeatureAccessForOrganizationRole({ organizationId: site.organizationId, role: "viewer" }),
    db
      .select({ metadataJson: schema.pageSites.metadataJson })
      .from(schema.pageSites)
      .where(eq(schema.pageSites.id, site.id))
      .limit(1),
  ]);
  return access.byKey["console.pages.chat"].enabled && parsePageChatSiteSettings(row?.metadataJson).enabled;
}

function isHtmlFile(file: PagesResolveFile) {
  const contentType = file.mimeType ?? contentTypeForPath(file.path);
  return contentType.split(";")[0]?.trim().toLowerCase() === "text/html";
}

async function resolveReservedAsset({
  assetPath,
  guestAccessVerifier,
  host,
  release,
  repository,
  routes,
  site,
  pagesSession,
  pagesPasswordSession,
  passwordAccessVerifier,
  privateAccessVerifier,
  requestId,
}: {
  assetPath: ReservedAssetPath;
  guestAccessVerifier: PagesGuestAccessVerifier;
  host: string;
  release: PagesResolveRelease;
  repository: PagesRouteResolveRepository;
  routes: PagesResolveRoute[];
  site: PagesResolveSite;
  pagesSession?: string | null;
  pagesPasswordSession?: string | null;
  passwordAccessVerifier: PagesPasswordAccessVerifier;
  privateAccessVerifier: PagesPrivateAccessVerifier;
  requestId?: string | null;
}): Promise<PagesRouteResolveResponse> {
  const candidateRoutes = routes.filter(
    (route) => route.artifactId === assetPath.artifactId && route.artifactVersionId === assetPath.artifactVersionId,
  );
  if (candidateRoutes.length === 0) return notFound();

  const visibleRoute = await visibleRouteForAsset(
    pagesSession,
    pagesPasswordSession,
    site,
    host,
    requestId,
    privateAccessVerifier,
    passwordAccessVerifier,
    guestAccessVerifier,
    candidateRoutes,
  );
  if (!visibleRoute) {
    const hasPasswordRoute = candidateRoutes.some(
      (route) => effectiveVisibility(site.defaultVisibility, route.visibility) === "password",
    );
    return hasPasswordRoute ? passwordRequiredResponse() : privateResponse();
  }

  const file = await repository.getArtifactVersionFile({
    artifactId: assetPath.artifactId,
    artifactVersionId: assetPath.artifactVersionId,
    path: assetPath.filePath,
  });

  if (!file || file.artifactStatus !== "active" || file.versionStatus !== "ready") return notFound();

  return resolvedFileResponse({
    file,
    release,
    route: visibleRoute,
    site,
  });
}

async function visibleRouteForAsset(
  pagesSession: string | null | undefined,
  pagesPasswordSession: string | null | undefined,
  site: PagesResolveSite,
  host: string,
  requestId: string | null | undefined,
  privateAccessVerifier: PagesPrivateAccessVerifier,
  passwordAccessVerifier: PagesPasswordAccessVerifier,
  guestAccessVerifier: PagesGuestAccessVerifier,
  routes: PagesResolveRoute[],
) {
  const publicRoute = routes.find((route) => effectiveVisibility(site.defaultVisibility, route.visibility) === "public");
  if (publicRoute) return publicRoute;
  if (await privateAccessVerifier({ host, pagesSession, requestId, site })) return routes[0] ?? null;
  if (pagesSession) {
    for (const route of routes) {
      if (
        isGuestShareableVisibility(effectiveVisibility(site.defaultVisibility, route.visibility)) &&
        await guestAccessVerifier({ host, pagesSession, requestId, routeId: route.routeId, site })
      ) {
        return route;
      }
    }
  }
  for (const route of routes) {
    if (
      effectiveVisibility(site.defaultVisibility, route.visibility) === "password" &&
      await passwordAccessVerifier({
        host,
        pagesPasswordSession,
        requestId,
        routeId: route.routeId,
        routeVisibility: route.visibility,
        site,
      })
    ) {
      return route;
    }
  }
  return null;
}

async function canViewPasswordRoute({
  host,
  pagesPasswordSession,
  requestId,
  routeId,
  routeVisibility,
  site,
}: Parameters<PagesPasswordAccessVerifier>[0]) {
  return verifyPagesPasswordSessionForRoute({
    host,
    requestId: requestId ?? "pages-resolve",
    routeId,
    routeVisibility,
    sessionToken: pagesPasswordSession,
    site,
  });
}

/** Private and protected-link pages can be given to a person; password pages keep their password. */
export function isGuestShareableVisibility(visibility: PageVisibility) {
  return visibility === "private" || visibility === "protected_link";
}

async function canGuestViewRoute({
  host,
  pagesSession,
  requestId,
  routeId,
  site,
}: Parameters<PagesGuestAccessVerifier>[0]) {
  return verifyPagesGuestSessionForRoute({
    canViewRoute: (grantInput) => canUserViewPagesRoute(grantInput),
    host,
    requestId: requestId ?? "pages-resolve",
    routeId,
    sessionToken: pagesSession,
    site,
  });
}

/**
 * Whether a guest may sign in to the page at `path`: it must match a private
 * route of the live release that they were given, alone or with its site.
 * Matching the route here keeps sign-in from looping on pages they lack.
 */
export async function pagesGuestCanViewPath(
  input: { path: string; site: PagesAuthSite; userId: string },
  repository: PagesRouteResolveRepository = pagesRouteResolveRepositoryForDb(),
) {
  const site = await repository.findSiteByHost(input.site.defaultHostname);
  if (!site || site.id !== input.site.id || site.status !== "active") return false;
  const release = await repository.getActiveRelease(site);
  if (!release || release.status !== "active") return false;
  const routes = await repository.listReleaseRoutes(release.id);
  const matched = matchPageRoute(
    routes.map((route) => ({ id: route.id, matchType: route.matchType, path: route.path, priority: route.priority })),
    input.path,
  );
  const route = matched ? routes.find((candidate) => candidate.id === matched.id) : null;
  if (!route) return false;
  if (!isGuestShareableVisibility(effectiveVisibility(site.defaultVisibility, route.visibility))) return false;
  return canUserViewPagesRoute({ routeId: route.routeId, siteId: site.id, userId: input.userId });
}

async function canViewPrivateRoute({
  host,
  pagesSession,
  requestId,
  site,
}: {
  host: string;
  pagesSession: string | null | undefined;
  requestId: string | null | undefined;
  site: PagesResolveSite;
}) {
  return Boolean(
    await verifyPagesSessionForSite({
      host,
      requestId: requestId ?? "pages-resolve",
      sessionToken: pagesSession,
      site,
    }),
  );
}

function resolvedFileResponse({
  file,
  guestChat = false,
  host,
  pageChat = false,
  release,
  route,
  site,
  toolbarVisibility,
}: {
  file: PagesResolveFile;
  guestChat?: boolean;
  host?: string | null;
  pageChat?: boolean;
  release: PagesResolveRelease;
  route: PagesResolveRoute;
  site: PagesResolveSite;
  toolbarVisibility?: PageVisibility | null;
}): PagesRouteResolveResponse {
  const objectPath = file.path;
  const contentType = file.mimeType ?? contentTypeForPath(objectPath);
  const cacheMode = cacheModeFor({ contentType, objectPath, route, site });
  const cacheControl = cacheControlFor(cacheMode);
  const etag = etagFor(file.sha256 ?? file.versionSha256);
  const storedR2Key = readR2Key(file.storageJson);
  if (
    storedR2Key &&
    storedR2Key !== expectedR2Key(site, route, objectPath) &&
    !isFinalObjectKeyForArtifact({
      artifactId: route.artifactId,
      artifactVersionId: route.artifactVersionId,
      key: storedR2Key,
      path: objectPath,
    })
  ) {
    return stateResponse("error", 503, "resolved_non_final_object_key");
  }
  const r2Key = storedR2Key ?? expectedR2Key(site, route, objectPath);
  const headers = safeObjectHeaders({
    cacheControl,
    contentType,
    etag,
  });

  return {
    status: "ok",
    httpStatus: 200,
    site: {
      id: site.id,
      organizationId: site.organizationId,
      projectId: site.projectId,
      visibility: site.defaultVisibility,
    },
    release: {
      id: release.id,
      number: release.releaseNumber,
    },
    route: {
      id: route.routeId,
      bindingId: route.id,
      path: route.path,
      matchType: route.matchType,
      visibility: route.visibility,
      ...browserPermissionsProjection(route.routeConfigJson),
    },
    artifact: {
      id: route.artifactId,
      versionId: route.artifactVersionId,
      versionNumber: file.versionNumber,
      entrypoint: route.entrypoint,
      assetBase: route.assetBase,
      sha256: file.versionSha256,
    },
    object: {
      path: objectPath,
      assetId: file.assetId,
      r2Key,
      contentType,
      cache: cacheMode,
      etag,
      sha256: file.sha256,
      sizeBytes: file.sizeBytes,
    },
    cache: {
      mode: cacheMode,
      control: cacheControl,
    },
    headers,
    toolbar:
      toolbarVisibility && host
        ? {
            enabled: true,
            host,
            path: route.path,
            effectiveVisibility: toolbarVisibility,
            siteId: site.id,
            projectId: site.projectId,
            routeId: route.routeId,
            releaseId: release.id,
            releaseNumber: release.releaseNumber,
            artifactId: route.artifactId,
            artifactVersionId: route.artifactVersionId,
            artifactVersionNumber: file.versionNumber,
            ...(pageChat ? { pageChat: { enabled: true as const } } : {}),
          }
        : undefined,
    ...(guestChat && !toolbarVisibility ? { guestChat: { enabled: true as const } } : {}),
  };
}

export function normalizeHostname(host: string): string | null {
  if (typeof host !== "string") return null;

  const withoutPort = host.trim().toLowerCase().replace(/\.$/, "").replace(/:\d+$/, "");
  if (!withoutPort || withoutPort.includes("/") || withoutPort.includes("@")) return null;

  return withoutPort;
}

function hostedSlugFromHost(host: string) {
  const domain = hostedPagesDomain();
  const suffix = `.${domain}`;
  if (!host.endsWith(suffix) || host === domain) return null;

  const slug = host.slice(0, -suffix.length);
  return slug && !slug.includes(".") ? slug : null;
}

function wildcardHostnamesForHost(host: string) {
  const labels = host.split(".");
  if (labels.length < 3) return [];

  const candidates: string[] = [];
  for (let index = 1; index < labels.length - 1; index += 1) {
    candidates.push(`*.${labels.slice(index).join(".")}`);
  }
  return candidates;
}

type ReservedAssetPath = {
  artifactId: string;
  artifactVersionId: string;
  filePath: string;
};

function parseReservedAssetPath(path: string): ReservedAssetPath | null {
  if (!path.startsWith(RESERVED_ASSET_PREFIX)) return null;

  const rest = path.slice(RESERVED_ASSET_PREFIX.length);
  const [artifactId, artifactVersionId, ...filePathParts] = rest.split("/");
  if (!artifactId || !artifactVersionId || filePathParts.length === 0) return null;

  const filePath = validateManifestFilePath(filePathParts.join("/"));
  if (!filePath.ok) return null;

  return {
    artifactId,
    artifactVersionId,
    filePath: filePath.path,
  };
}

function artifactPathForRequest(route: PagesResolveRoute, requestPath: string): string | null {
  const rawPath = rawArtifactPathForRequest(route, requestPath);
  const normalized = validateManifestFilePath(rawPath);

  return normalized.ok ? normalized.path : null;
}

function rawArtifactPathForRequest(route: PagesResolveRoute, requestPath: string) {
  if (route.matchType === "exact") return route.entrypoint;
  if (requestPath === route.path) return route.entrypoint;
  if (route.path === "/") return requestPath.replace(/^\/+/, "") || route.entrypoint;

  return requestPath.slice(route.path.length).replace(/^\/+/, "") || route.entrypoint;
}

/**
 * What visitors get: a route that is not `public` keeps its own policy, and a
 * `public` route follows the host default. The read model reuses this rule.
 */
export function effectiveVisibility(siteVisibility: PageVisibility, routeVisibility: PageVisibility): PageVisibility {
  if (routeVisibility !== "public") return routeVisibility;
  return siteVisibility === "public" ? "public" : siteVisibility;
}

function cacheModeFor({
  contentType,
  objectPath,
  route,
  site,
}: {
  contentType: string;
  objectPath: string;
  route: PagesResolveRoute;
  site: PagesResolveSite;
}): PagesRouteCacheMode {
  if (effectiveVisibility(site.defaultVisibility, route.visibility) !== "public") return "private";
  if (objectPath === route.entrypoint || contentType.toLowerCase().startsWith("text/html")) return "entrypoint";

  return "immutable";
}

function cacheControlFor(mode: PagesRouteCacheMode) {
  if (mode === "immutable") return IMMUTABLE_CACHE_CONTROL;
  if (mode === "entrypoint") return ENTRYPOINT_CACHE_CONTROL;
  return NO_STORE_CACHE_CONTROL;
}

function safeObjectHeaders({
  cacheControl,
  contentType,
  etag,
}: {
  cacheControl: string;
  contentType: string;
  etag: string | null;
}) {
  const headers: Record<string, string> = {
    "cache-control": cacheControl,
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  };

  if (etag) headers.etag = etag;
  return headers;
}

function browserPermissionsProjection(routeConfigJson: unknown): Record<string, unknown> {
  const browserPermissions = record(record(routeConfigJson).browserPermissions);
  return browserPermissions.deviceMotion === "self"
    ? { browserPermissions: { deviceMotion: "self" } }
    : {};
}

function notFound(): PagesRouteResolveStateResponse {
  return stateResponse("not_found", 404, "not_found");
}

function privateResponse(): PagesRouteResolveStateResponse {
  return stateResponse("private", 401, "private_auth_required");
}

function passwordRequiredResponse(): PagesRouteResolveStateResponse {
  return stateResponse("password_required", 401, "password_required");
}

function redirectResponse(
  redirectToHostname: string | null | undefined,
  requestPath: string,
  requestSearch?: string | null,
): PagesRouteResolveStateResponse {
  const hostname = normalizeHostname(redirectToHostname ?? "");
  if (!hostname) return notFound();

  const location = `https://${hostname}${safeRedirectPath(requestPath)}${safeRedirectSearch(requestSearch)}`;
  return {
    status: "redirect",
    httpStatus: 308,
    code: "pages_domain_redirect",
    headers: {
      "cache-control": "public, max-age=300",
      location,
      "x-content-type-options": "nosniff",
    },
    redirect: {
      location,
    },
  };
}

function stateResponse(
  status: Exclude<PagesRouteResolveStatus, "ok">,
  httpStatus: PagesRouteResolveStateResponse["httpStatus"],
  code: string,
): PagesRouteResolveStateResponse {
  return {
    status,
    httpStatus,
    code,
    headers: {
      "cache-control": NO_STORE_CACHE_CONTROL,
      "x-content-type-options": "nosniff",
    },
  };
}

function safeRedirectPath(path: string) {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) return "/";
  if (/[\u0000-\u001F\u007F]/.test(path)) return "/";
  return path;
}

function safeRedirectSearch(search: string | null | undefined) {
  if (!search) return "";
  if (typeof search !== "string" || !search.startsWith("?") || search.startsWith("??")) return "";
  if (/[\u0000-\u001F\u007F]/.test(search)) return "";
  return search;
}

function readR2Key(storageJson: Record<string, unknown>) {
  for (const key of ["r2Key", "objectKey", "key"]) {
    const value = storageJson[key];
    if (typeof value === "string" && value.length > 0) return value;
  }

  return null;
}

function expectedR2Key(site: PagesResolveSite, route: PagesResolveRoute, objectPath: string) {
  return `org/${site.organizationId}/project/${site.projectId}/artifact/${route.artifactId}/version/${route.artifactVersionId}/${objectPath}`;
}

function contentTypeForPath(path: string) {
  const lowerPath = path.toLowerCase();
  if (lowerPath.endsWith(".html") || lowerPath.endsWith(".htm")) return "text/html; charset=utf-8";
  if (lowerPath.endsWith(".css")) return "text/css; charset=utf-8";
  if (lowerPath.endsWith(".js") || lowerPath.endsWith(".mjs")) return "application/javascript; charset=utf-8";
  if (lowerPath.endsWith(".json")) return "application/json; charset=utf-8";
  if (lowerPath.endsWith(".svg")) return "image/svg+xml";
  if (lowerPath.endsWith(".png")) return "image/png";
  if (lowerPath.endsWith(".jpg") || lowerPath.endsWith(".jpeg")) return "image/jpeg";
  if (lowerPath.endsWith(".webp")) return "image/webp";
  if (lowerPath.endsWith(".ico")) return "image/x-icon";
  if (lowerPath.endsWith(".txt")) return "text/plain; charset=utf-8";

  return "application/octet-stream";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function etagFor(sha256: string | null | undefined) {
  return sha256 ? `"sha256:${sha256}"` : null;
}
