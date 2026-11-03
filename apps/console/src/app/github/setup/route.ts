import { NextRequest, NextResponse } from "next/server";

import { orgSegment } from "@/lib/console-paths";
import { getConsoleApiAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  assertStateMatchesWorkspace,
  readGithubAppState,
  startGithubUserAuthorization,
} from "@/server/console/github-app";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { getConsoleWorkspace } from "@/server/console/workspace";

import { githubPage, loginUrl } from "../redirects";

export const runtime = "nodejs";

/**
 * GitHub's Setup URL: GitHub lands here after the Ravi app is installed or
 * changed. The `installation_id` GitHub puts in this URL can be forged, so
 * nothing is linked here; the person signs in with GitHub next, and the
 * callback links the installation only if GitHub lists it for them.
 */
export async function GET(request: NextRequest) {
  const auth = await getConsoleApiAuthState();
  if (!auth) return NextResponse.redirect(loginUrl(request));

  const state = readGithubAppState(request.nextUrl.searchParams.get("state"));
  if (!state) return NextResponse.redirect(githubPage(request, null, "expired"));

  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef: state.organizationId });
    await assertConsoleFeatureAccess(workspace, "console.github");
    assertStateMatchesWorkspace(state, workspace);
    const org = orgSegment(workspace.organization);

    const installationId = request.nextUrl.searchParams.get("installation_id")?.trim();
    if (!installationId) {
      // An organization member without admin rights on GitHub only asks for the install.
      const requested = request.nextUrl.searchParams.get("setup_action") === "request";
      return NextResponse.redirect(githubPage(request, org, requested ? "requested" : "error"));
    }
    return NextResponse.redirect(startGithubUserAuthorization(workspace, installationId));
  } catch (error) {
    const status = error instanceof ConsoleApiError && error.payload.error === "github_sign_in_not_configured"
      ? "sign_in_not_configured"
      : "error";
    return NextResponse.redirect(githubPage(request, null, status));
  }
}
