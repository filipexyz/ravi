import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  createBugReport,
  listBugReportsForReporter,
  mapBugReportCliError,
  MAX_BUG_REPORT_BODY_BYTES,
} from "@/server/console/bug-reports";

export const runtime = "nodejs";

export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    return cliSuccess(await listBugReportsForReporter(auth.user.id));
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const payload = await createBugReport({
      body: await readJsonBody(request, requestId, { maxBytes: MAX_BUG_REPORT_BODY_BYTES }),
      requestId,
      reporterUserId: auth.user.id,
      defaultOrganizationId: auth.organization.id,
      actorType: "cli",
    });
    return cliSuccess(
      {
        id: payload.id,
        status: payload.status,
        consoleUrl: payload.consoleUrl,
        title: payload.title,
        severity: payload.severity,
        createdAt: payload.createdAt,
      },
      { status: 201 },
    );
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}
