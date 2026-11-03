import { CONSOLE_ORGANIZATION_HEADER, CONSOLE_ORGANIZATION_PARAM, orgFromPath } from "@/lib/console-paths";

/** The organization of the page the browser is on, from its URL. */
export function browserOrganization() {
  if (typeof window === "undefined") return null;
  return orgFromPath(window.location.pathname);
}

/**
 * Headers that tell the Console API which organization the page shows, so a
 * tab on one organization never reads another one picked in a different tab.
 */
export function organizationHeaders(): Record<string, string> {
  const org = browserOrganization();
  return org ? { [CONSOLE_ORGANIZATION_HEADER]: org } : {};
}

/** Adds the page's organization to a URL the browser loads without headers (images, event streams). */
export function withOrganizationParam(url: string) {
  const org = browserOrganization();
  if (!org) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}${CONSOLE_ORGANIZATION_PARAM}=${encodeURIComponent(org)}`;
}
