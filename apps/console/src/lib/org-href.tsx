"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useMemo } from "react";

import { orgPath, parseOrgPath } from "@/lib/console-paths";

const OrgSegmentContext = createContext<string | null>(null);

/** The organization the Console shell opened, for screens whose URL names none. */
export function OrgSegmentProvider({ children, value }: { children: React.ReactNode; value: string }) {
  return <OrgSegmentContext.Provider value={value}>{children}</OrgSegmentContext.Provider>;
}

/**
 * The organization segment links on this page use: the one in the URL, or,
 * on screens that belong to no organization, the one the shell opened.
 */
export function useOrgSegment(): string | null {
  const pathname = usePathname();
  const shellOrg = useContext(OrgSegmentContext);
  return parseOrgPath(pathname ?? "/").org ?? shellOrg;
}

/**
 * Turns an app path (`/projects`, `/org/members`, `/p/<id>/pages`) into the
 * URL of the current organization (`/<org>`, `/<org>/members`,
 * `/<org>/p/<id>/pages`). Anything else, organization URLs and external links
 * included, comes back unchanged. The Console's link primitives (Button,
 * MenuItem, ListRow, TabNav, DataTable, `@/ui/link`) already apply it.
 */
export function useOrgHref() {
  const org = useOrgSegment();
  return useCallback((path: string) => (org ? orgPath(org, path) : path), [org]);
}

/** `useRouter` whose `push` and `replace` take app paths, like the link primitives. */
export function useOrgRouter() {
  const router = useRouter();
  const orgHref = useOrgHref();
  return useMemo(
    () => ({
      ...router,
      push: (href: string, options?: Parameters<typeof router.push>[1]) => router.push(orgHref(href), options),
      replace: (href: string, options?: Parameters<typeof router.replace>[1]) => router.replace(orgHref(href), options),
      prefetch: (href: string, options?: Parameters<typeof router.prefetch>[1]) => router.prefetch(orgHref(href), options),
    }),
    [orgHref, router],
  );
}

/** The app path of the current URL, with the organization segment read away. */
export function useAppPathname() {
  const pathname = usePathname() ?? "/";
  return parseOrgPath(pathname).path;
}
