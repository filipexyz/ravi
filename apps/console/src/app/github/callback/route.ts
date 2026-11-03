import { randomUUID } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

import { orgSegment } from "@/lib/console-paths";
import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  completeGithubUserAuthorization,
  GITHUB_USER_SESSION_COOKIE,
  GITHUB_USER_SESSION_MAX_AGE_SECONDS,
  readGithubAppState,
} from "@/server/console/github-app";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { getConsoleWorkspace } from "@/server/console/workspace";

import { githubPage, loginUrl } from "../redirects";

export const runtime = "nodejs";

/** GitHub's Callback URL: the person comes back from signing in with GitHub. */
export async function GET(request: NextRequest) {
  const auth = await getConsoleApiAuthState();
  if (!auth) return NextResponse.redirect(loginUrl(request));

  const state = readGithubAppState(request.nextUrl.searchParams.get("state"));
  if (!state) return NextResponse.redirect(githubPage(request, null, "expired"));
  if (request.nextUrl.searchParams.get("error")) {
    return NextResponse.redirect(githubPage(request, null, "denied"));
  }

  let org: string | null = null;
  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef: state.organizationId });
    org = orgSegment(workspace.organization);
    await assertConsoleFeatureAccess(workspace, "console.github");
    const result = await completeGithubUserAuthorization({
      code: request.nextUrl.searchParams.get("code"),
      requestId: request.headers.get("x-request-id") ?? randomUUID(),
      state,
      workspace,
    });

    const response = NextResponse.redirect(githubPage(request, org, result.linkedInstallationId ? "linked" : "signed_in"));
    response.cookies.set(GITHUB_USER_SESSION_COOKIE, result.session, {
      httpOnly: true,
      maxAge: GITHUB_USER_SESSION_MAX_AGE_SECONDS,
      // Only the Console API that reads it, never the rest of the Console.
      path: "/api/console/github",
      sameSite: "lax",
      secure: request.nextUrl.protocol === "https:",
    });
    return response;
  } catch (error) {
    const status = error instanceof ConsoleApiError && error.payload.error === "github_installation_not_accessible"
      ? "not_accessible"
      : "error";
    return NextResponse.redirect(githubPage(request, org, status));
  }
}
