import { gateAdminRequest, adminErrorResponse, adminJson } from "@/server/admin/http";
import { deleteBugReport, getAdminBugReport } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function GET(request: Request, context: RouteContext) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-get-unauthorized",
    missingTokenLog: "Admin bug report detail endpoint missing RAVI_ADMIN_TOKEN",
  });
  if (!gate.ok) return gate.response;

  try {
    const { id } = await context.params;
    const result = await getAdminBugReport(id);
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "bug_get_failed");
  }
}

export async function DELETE(request: Request, context: RouteContext) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-delete-unauthorized",
    missingTokenLog: "Admin bug report delete endpoint missing RAVI_ADMIN_TOKEN",
  });
  if (!gate.ok) return gate.response;

  try {
    const { id } = await context.params;
    const result = await deleteBugReport({
      id,
      requestId: gate.requestId,
      actorType: "system",
      actorId: null,
    });
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "bug_delete_failed");
  }
}
