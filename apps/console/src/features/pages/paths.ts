import { useSyncExternalStore } from "react";

/**
 * Every link into the Pages screens. These are app paths: the Console's link
 * primitives add the organization when URLs carry one.
 *
 * - `/p/<project>/pages` lists the project's pages.
 * - `/p/<project>/pages/<host>` is the same list; the page's top bar links here.
 * - `/p/<project>/pages/<host>/<page>` is one page.
 * - `/p/<project>/pages/<host>/settings` is that host's settings.
 */
export function pagesHref(projectId: string) {
  return `/p/${encodeURIComponent(projectId)}/pages`;
}

export function pageHref(projectId: string, page: { siteId: string; routeId: string }, hash?: string) {
  return `${pagesHref(projectId)}/${encodeURIComponent(page.siteId)}/${encodeURIComponent(page.routeId)}${hash ? `#${hash}` : ""}`;
}

export function pagesSettingsHref(projectId: string, siteId: string, hash?: string) {
  return `${pagesHref(projectId)}/${encodeURIComponent(siteId)}/settings${hash ? `#${hash}` : ""}`;
}

/** The list a page's Back link returns to: the last list the person saw, with its search and filter. */
const LAST_LIST_KEY = "ravi.pages.lastList";

export function rememberListHref(href: string) {
  try {
    window.sessionStorage.setItem(LAST_LIST_KEY, href);
  } catch {
    // Storage can be off (private windows); Back then goes to the plain list.
  }
}

export function lastListHref(projectId: string) {
  const fallback = pagesHref(projectId);
  try {
    const stored = window.sessionStorage.getItem(LAST_LIST_KEY);
    return stored && stored.startsWith(fallback) ? stored : fallback;
  } catch {
    return fallback;
  }
}

const noSubscription = () => () => {};

/** The Back link to the list: the plain list on the server, the remembered one once in the browser. */
export function useBackHref(projectId: string) {
  return useSyncExternalStore(
    noSubscription,
    () => lastListHref(projectId),
    () => pagesHref(projectId),
  );
}
