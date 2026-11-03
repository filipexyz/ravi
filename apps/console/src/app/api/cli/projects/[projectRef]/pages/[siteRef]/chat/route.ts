import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  cliHasPageChatReadScopes,
  cliHasPageChatWriteScopes,
  pageChatCliError,
  showPageChatSettingsFromCli,
  updatePageChatSettingsFromCli,
  type PageChatCliDeps,
  type PageChatCliWorkspace,
} from "@/server/console/pages/chat/cli";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string; siteRef: string }>;
};

export const runtime = "nodejs";

export async function GET(request: NextRequest, context: RouteContext) {
  return handlePageChatSettingsCli(request, context);
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  return handlePageChatSettingsCli(request, context);
}

export async function handlePageChatSettingsCli(
  request: NextRequest,
  context: RouteContext,
  deps: PageChatCliDeps & { authenticate?: typeof authenticateCliRequest } = {},
) {
  const requestId = requestIdFrom(request);
  const { projectRef, siteRef } = await context.params;
  const headers = { "cache-control": "no-store", "x-request-id": requestId };

  try {
    const auth = await (deps.authenticate ?? authenticateCliRequest)(request, requestId);
    const method = request.method.toUpperCase();
    const allowed = method === "GET" ? cliHasPageChatReadScopes(auth.scopes) : cliHasPageChatWriteScopes(auth.scopes);
    if (!allowed) return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));

    const workspace = workspaceFromCliAuth(auth);
    if (method === "GET") {
      return cliSuccess(await showPageChatSettingsFromCli({ projectRef, siteRef, workspace }, deps), { headers });
    }
    if (method === "PATCH") {
      return cliSuccess(
        await updatePageChatSettingsFromCli(
          {
            body: await readJsonBody(request, requestId, { maxBytes: 8_192 }),
            projectRef,
            requestId,
            siteRef,
            workspace,
          },
          deps,
        ),
        { headers },
      );
    }
    return noStore(cliFailure(cliApiError(400, "PAYLOAD_INVALID"), requestId));
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return noStore(cliFailure(pageChatCliError(error), requestId));
    }
    return noStore(cliFailure(error, requestId));
  }
}

function noStore<T extends Response>(response: T) {
  response.headers.set("cache-control", "no-store");
  return response;
}

function workspaceFromCliAuth(auth: Awaited<ReturnType<typeof authenticateCliRequest>>): PageChatCliWorkspace {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos",
    user: { id: auth.user.id },
    organization: { id: auth.organization.id },
    membership: { role },
  };
}
