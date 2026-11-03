import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { getBugReportForReporter, mapBugReportCliError } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const { id } = await context.params;
    return cliSuccess(await getBugReportForReporter({ id, reporterUserId: auth.user.id }));
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}
