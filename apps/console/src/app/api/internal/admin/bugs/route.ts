import { gateAdminRequest, adminErrorResponse, adminJson } from "@/server/admin/http";
import { listAdminBugReports } from "@/server/console/bug-reports";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-list-unauthorized",
    missingTokenLog: "Admin bug report list endpoint missing RAVI_ADMIN_TOKEN",
  });
  if (!gate.ok) return gate.response;

  try {
    const result = await listAdminBugReports(new URL(request.url).searchParams);
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "bug_list_failed");
  }
}
