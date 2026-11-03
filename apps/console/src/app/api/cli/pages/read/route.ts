import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { readPageForCli } from "@/server/console/pages/cli-read";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read") || !auth.scopes.includes("artifacts.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }
    const role = parseConsoleRole(auth.membership.role);
    if (!role) return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    const input = await readJsonBody(request, requestId, { maxBytes: 16_384 });
    const page = await readPageForCli({
      input,
      requestId,
      workspace: { authorization: projectAuthorizationFromCli(auth),
        user: { id: auth.user.id },
        organization: { id: auth.organization.id },
        membership: { role },
      },
    });
    return cliSuccess(page);
  } catch (error) {
    return cliFailure(mapPageReadError(error), requestId);
  }
}

function mapPageReadError(error: unknown) {
  if (!(error instanceof ConsoleApiError)) return error;
  const fieldErrors = error.payload.fieldErrors as Record<string, unknown> | undefined;
  switch (error.payload.error) {
    case "validation_failed":
    case "invalid_url":
      return cliApiError(400, "PAYLOAD_INVALID", "Pass a Ravi Page URL such as https://acme.ravi.page/weekly.");
    case "page_not_found":
      return cliApiError(404, "NOT_FOUND", "No published Ravi Page answers at this URL.");
    case "page_access_denied":
      return cliApiError(403, "PAGE_ACCESS_DENIED", pageAccessDeniedMessage(fieldErrors?.reason), {
        reason: fieldErrors?.reason ?? "project_forbidden",
      });
    case "page_content_unsupported":
      return cliApiError(415, "PAGE_CONTENT_UNSUPPORTED", undefined, {
        contentType: fieldErrors?.contentType ?? null,
        path: fieldErrors?.path ?? null,
      });
    case "page_too_large":
      return cliApiError(
        413,
        "PAGE_CONTENT_UNSUPPORTED",
        fieldErrors?.fileCount === undefined
          ? "This Ravi Page file is larger than 2 MB. Use format files to download it."
          : "This Ravi Page has more than 1000 files or 100 MB.",
        { fileCount: fieldErrors?.fileCount ?? null, sizeBytes: fieldErrors?.sizeBytes ?? null },
      );
    default:
      return cliApiError(503, "SERVER_UNAVAILABLE", "The Ravi Page could not be read right now.");
  }
}

function pageAccessDeniedMessage(reason: unknown) {
  switch (reason) {
    case "public_only":
      return "This Ravi Page is not public, and this request may only read public Pages.";
    case "org_forbidden":
      return "This Ravi Page belongs to another organization than this CLI session.";
    case "password_route":
      return "This Ravi Page route is password protected.";
    default:
      return "This CLI session cannot read this project's Ravi Pages.";
  }
}
