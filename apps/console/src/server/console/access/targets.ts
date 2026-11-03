import { ConsoleApiError } from "@/server/console/api-error";
import type { PageVisibility } from "@/server/console/pages";
import { parsePageUrl } from "@/server/console/pages/cli-read";
import { matchPageRoute } from "@/server/console/pages/policy";
import {
  effectiveVisibility,
  isGuestShareableVisibility,
  pagesRouteResolveRepositoryForDb,
  type PagesResolveRoute,
  type PagesResolveSite,
  type PagesRouteResolveRepository,
} from "@/server/console/pages/resolve";

/** A Ravi Page URL resolved to its site and, when one matches, its live route. */
export type PageTarget = {
  host: string;
  path: string;
  route: PagesResolveRoute | null;
  site: PagesResolveSite;
  /** Effective visibility of the route, or the site default when no route matches. */
  visibility: PageVisibility;
};

/**
 * Resolves `https://<host>/<path>` (default host or custom domain) like the
 * Pages Worker does: the site by host, then the live release's route for the
 * path. Throws `invalid_url` or `site_not_found`; a path no route matches
 * comes back with `route: null`.
 */
export async function resolvePageTarget(
  url: string,
  repository: PagesRouteResolveRepository = pagesRouteResolveRepositoryForDb(),
): Promise<PageTarget> {
  const parsed = parsePageUrl(url);
  if (!parsed) throw new ConsoleApiError(400, { error: "invalid_url" });
  const site = await repository.findSiteByHost(parsed.host);
  if (!site || site.status !== "active") throw new ConsoleApiError(404, { error: "site_not_found" });

  const release = await repository.getActiveRelease(site);
  const routes = release && release.status === "active" ? await repository.listReleaseRoutes(release.id) : [];
  const matched = matchPageRoute(
    routes.map((route) => ({ id: route.id, matchType: route.matchType, path: route.path, priority: route.priority })),
    parsed.path,
  );
  const route = matched ? (routes.find((candidate) => candidate.id === matched.id) ?? null) : null;
  return {
    host: parsed.host,
    path: route?.path || parsed.path || "/",
    route,
    site,
    visibility: route ? effectiveVisibility(site.defaultVisibility, route.visibility) : site.defaultVisibility,
  };
}

/** Grants and requests make sense only where a grant would open the page. */
export function isGrantableTarget(target: PageTarget) {
  return isGuestShareableVisibility(target.visibility);
}
