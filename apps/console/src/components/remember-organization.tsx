"use client";

import { useEffect } from "react";

/**
 * Remembers the organization this page opened, so screens that belong to no
 * organization (`/bugs`, an old link without one) open it next.
 */
export function RememberOrganization({ organizationId }: { organizationId: string }) {
  useEffect(() => {
    void fetch("/api/console/organizations/remember", {
      body: JSON.stringify({ organizationId }),
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      method: "POST",
    }).catch(() => undefined);
  }, [organizationId]);
  return null;
}
