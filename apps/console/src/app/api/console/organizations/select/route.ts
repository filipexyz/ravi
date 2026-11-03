import { NextRequest, NextResponse } from "next/server";
import { switchToOrganization } from "@workos-inc/authkit-nextjs";

import { safeAuthReturnTo } from "@/lib/auth/return-to";
import { consoleRedirectUrl, isConsoleMutationOrigin } from "@/lib/auth/console-origin";
import { getConsoleApiAuthState, WORKOS_PROVIDER } from "@/lib/auth/session";
import { returnToForOrganization } from "@/server/console/org-urls";
import { setConsoleOrganizationCookie } from "@/server/console/request-workspace";
import {
  ConsoleWorkspaceSelectionRequiredError,
  getLinkedProviderOrganizationIdForOrganization,
  getConsoleWorkspace,
  isSwitchableWorkOSOrganizationId,
} from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  if (!isConsoleMutationOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const auth = await getConsoleApiAuthState();
  if (!auth) {
    return NextResponse.redirect(consoleRedirectUrl("/login", request.url), { status: 303 });
  }

  const form = await request.formData();
  const organizationRef = stringValue(form.get("organizationId") ?? form.get("organizationSlug"));
  if (!organizationRef) {
    return NextResponse.redirect(consoleRedirectUrl("/org?select=missing", request.url), { status: 303 });
  }

  try {
    const workspace = await getConsoleWorkspace(auth, { organizationRef });
    const returnTo = returnToForOrganization(workspace.organization, safeReturnTo(form.get("returnTo")));
    const linkedWorkOSOrganizationId =
      auth.mode === "workos"
        ? await getLinkedProviderOrganizationIdForOrganization({
            organizationId: workspace.organization.id,
            provider: WORKOS_PROVIDER,
          })
        : null;

    if (
      isSwitchableWorkOSOrganizationId(linkedWorkOSOrganizationId) &&
      linkedWorkOSOrganizationId !== auth.initialAuth?.organizationId
    ) {
      await switchToOrganization(linkedWorkOSOrganizationId, {
        returnTo,
        revalidationStrategy: "none",
      });
    }

    const response = NextResponse.redirect(consoleRedirectUrl(returnTo, request.url), {
      status: 303,
    });
    setConsoleOrganizationCookie(response, workspace.organization.id);
    return response;
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.redirect(consoleRedirectUrl("/org?select=denied", request.url), { status: 303 });
    }
    throw error;
  }
}

function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() || null : null;
}

function safeReturnTo(value: FormDataEntryValue | null) {
  return safeAuthReturnTo(stringValue(value));
}
