import { gateAdminRequest, adminErrorResponse, adminJson } from "@/server/admin/http";
import { updateBugReportStatus } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-unauthorized",
    missingTokenLog: "Admin bug report status endpoint missing RAVI_ADMIN_TOKEN",
  });
  if (!gate.ok) return gate.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return adminJson({ status: "error", code: "invalid_json", requestId: gate.requestId }, 400, gate.requestId);
  }

  try {
    const { id } = await context.params;
    const result = await updateBugReportStatus({ id, body, requestId: gate.requestId });
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "status_update_failed");
  }
}
