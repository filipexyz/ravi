import type { NextRequest } from "next/server";

import { orgPath } from "@/lib/console-paths";

/** The organization's GitHub settings, saying how the GitHub round trip ended. */
export function githubPage(request: NextRequest, org: string | null, status: string) {
  const url = new URL(org ? orgPath(org, "/org/github") : "/org/github", request.nextUrl.origin);
  url.searchParams.set("github", status);
  return url;
}

export function loginUrl(request: NextRequest) {
  const url = new URL("/login", request.nextUrl.origin);
  url.searchParams.set("next", `${request.nextUrl.pathname}${request.nextUrl.search}`);
  return url;
}
