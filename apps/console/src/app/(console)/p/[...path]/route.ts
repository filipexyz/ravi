import type { NextRequest } from "next/server";

import { redirectLegacyConsolePath } from "@/server/console/org-urls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** Links from before the organization was in the URL: redirect to the organization's URL. */
export function GET(request: NextRequest) {
  return redirectLegacyConsolePath(request);
}
