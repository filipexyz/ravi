import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { createBugReportComment } from "@/server/console/bug-report-comments";
import { mapBugReportCliError, MAX_BUG_REPORT_BODY_BYTES } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const { id } = await context.params;
    const result = await createBugReportComment({
      id,
      body: await readJsonBody(request, requestId, { maxBytes: MAX_BUG_REPORT_BODY_BYTES }),
      requestId,
      reporterUserId: auth.user.id,
      actorType: "cli",
      idempotencyKeyHeader: request.headers.get("idempotency-key"),
    });
    return cliSuccess(result, { status: result.reused ? 200 : 201 });
  } catch (error) {
    return cliFailure(mapBugReportCliError(error), requestId);
  }
}
