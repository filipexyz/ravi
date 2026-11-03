import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import {
  subscribeBugReportFollow,
  unsubscribeBugReportFollow,
} from "@/server/console/bug-report-follow";
import { mapBugReportCliError } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const { id } = await context.params;
    return cliSuccess(
      await subscribeBugReportFollow({
        id,
        reporterUserId: auth.user.id,
        localInstallationId: auth.localInstallation.id,
        organizationId: auth.organization.id,
      }),
      { status: 201 },
    );
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}

export async function DELETE(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const { id } = await context.params;
    return cliSuccess(
      await unsubscribeBugReportFollow({
        id,
        reporterUserId: auth.user.id,
        localInstallationId: auth.localInstallation.id,
      }),
    );
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}
