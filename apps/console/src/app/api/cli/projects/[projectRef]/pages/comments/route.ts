import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { getPageRouteComments } from "@/server/console/pages/comments";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const search = request.nextUrl.searchParams;
    const payload = await getPageRouteComments({
      markRead: truthy(search.get("markRead")),
      path: requiredQuery(search, "path"),
      projectRef,
      requestId,
      siteRef: requiredQuery(search, "siteRef"),
      workspace: workspaceFromCliAuth(auth),
    });
    return cliSuccess(payload);
  } catch (error) {
    return cliFailure(mapCommentsError(error), requestId);
  }
}

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.read")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const body = await readJsonBody(request, requestId, { maxBytes: 20_000 });
    const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
    const payload = await getPageRouteComments({
      markRead: true,
      path: requiredString(record.path, "path"),
      projectRef,
      requestId,
      siteRef: requiredString(record.siteRef, "siteRef"),
      workspace: workspaceFromCliAuth(auth),
    });
    return cliSuccess(payload);
  } catch (error) {
    return cliFailure(mapCommentsError(error), requestId);
  }
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos" as const,
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}

function requiredQuery(search: URLSearchParams, key: string) {
  return requiredString(search.get(key), key);
}

function requiredString(value: unknown, key: string) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw cliApiError(400, "PAYLOAD_INVALID", `Missing required field: ${key}.`);
  }
  return value.trim();
}

function truthy(value: string | null) {
  return value === "1" || value === "true" || value === "yes";
}

function mapCommentsError(error: unknown) {
  if (error instanceof ConsoleApiError) {
    if (error.payload.error === "invalid_path") return cliApiError(400, "PAYLOAD_INVALID");
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
  return error;
}
