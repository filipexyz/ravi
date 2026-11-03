import { z } from "zod";

import { gateAdminRequest, adminErrorResponse, adminJson } from "@/server/admin/http";
import { runBugTriageJobs } from "@/server/console/bug-triage-jobs";

export const runtime = "nodejs";

const bodySchema = z.object({
  limit: z.number().int().min(1).max(25).optional(),
});

export async function POST(request: Request) {
  const gate = gateAdminRequest(request, {
    rateLimitName: "admin-bugs-triage-jobs-run-unauthorized",
    missingTokenLog: "Admin bug triage worker endpoint missing RAVI_ADMIN_TOKEN",
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

  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return adminJson({ status: "error", code: "validation_failed", requestId: gate.requestId }, 400, gate.requestId);
  }

  try {
    const result = await runBugTriageJobs({ limit: parsed.data.limit });
    return adminJson({ status: "ok", requestId: gate.requestId, result }, 200, gate.requestId);
  } catch (error) {
    return adminErrorResponse(error, gate.requestId, "triage_jobs_run_failed");
  }
}
