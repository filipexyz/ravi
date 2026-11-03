"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

/** Moves a link from before an organization's rename to its new URL, keeping the rest of the path. */
export function RenamedOrganizationRedirect({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  useEffect(() => {
    const { hash, pathname, search } = window.location;
    const prefix = `/${encodeURIComponent(from)}`;
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return;
    router.replace(`/${encodeURIComponent(to)}${pathname.slice(prefix.length)}${search}${hash}`);
  }, [from, router, to]);
  return null;
}
