import { gateAdminRequest, adminErrorResponse, adminJson } from "@/server/admin/http";
import { storeBugReportTriage } from "@/server/console/bug-reports";

export const runtime = "nodejs";

type RouteContext = {
  params: Promise<{ id: string }>;
};

export async function POST(request: Request, context: RouteContext) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-triage-unauthorized",
    missingTokenLog: "Admin bug report triage endpoint missing RAVI_ADMIN_TOKEN",
  });
  if (!gate.ok) return gate.response;

  let body: unknown = {};
  const text = await request.text();
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return adminJson({ status: "error", code: "invalid_json", requestId: gate.requestId }, 400, gate.requestId);
    }
  }

  try {
    const { id } = await context.params;
    const result = await storeBugReportTriage({ id, body, requestId: gate.requestId });
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "triage_store_failed");
  }
}
