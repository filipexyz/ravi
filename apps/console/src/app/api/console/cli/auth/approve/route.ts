import { type NextRequest, NextResponse } from "next/server";

import { getConsoleApiAuthState } from "@/lib/auth/session";
import { consoleRedirectUrl, isConsoleMutationOrigin } from "@/lib/auth/console-origin";
import { approveCliDeviceAuthorization } from "@/server/cli/device-auth";
import { CliApiError } from "@/server/cli/errors";
import { requestIdFrom } from "@/server/cli/http";
import { ConsoleWorkspaceSelectionRequiredError } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  if (!isConsoleMutationOrigin(request)) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  const auth = await getConsoleApiAuthState();
  const form = await request.formData();
  const userCode = stringValue(form.get("userCode") ?? form.get("user_code"));
  const organizationRef = stringValue(form.get("organizationId") ?? form.get("organizationSlug"));
  const base = userCode ? `/cli/authorize?user_code=${encodeURIComponent(userCode)}` : "/cli/authorize";

  if (!auth) {
    return NextResponse.redirect(consoleRedirectUrl(`/login?returnTo=${encodeURIComponent(base)}`, request.url), { status: 303 });
  }

  if (!userCode) {
    return NextResponse.redirect(consoleRedirectUrl("/cli/authorize?error=missing_code", request.url), { status: 303 });
  }

  try {
    await approveCliDeviceAuthorization({
      auth,
      organizationRef,
      requestId,
      userCode,
    });
    return NextResponse.redirect(consoleRedirectUrl(`${base}&approved=1`, request.url), { status: 303 });
  } catch (error) {
    if (error instanceof ConsoleWorkspaceSelectionRequiredError) {
      return NextResponse.redirect(consoleRedirectUrl(`${base}&select=required`, request.url), { status: 303 });
    }
    if (error instanceof CliApiError) {
      return NextResponse.redirect(consoleRedirectUrl(`${base}&error=${encodeURIComponent(error.code)}`, request.url), { status: 303 });
    }
    throw error;
  }
}

function stringValue(value: FormDataEntryValue | null) {
  return typeof value === "string" ? value.trim() || null : null;
}
