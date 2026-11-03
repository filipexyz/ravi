import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, requestIdFrom } from "@/server/cli/http";
import { listOutdatedPages, PAGES_OUTDATED_CLI_SCOPE } from "@/server/console/pages/kit/outdated";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

// `ravi pages outdated`: active routes shipped with an older theme, widget or runtime.
export async function GET(request: NextRequest) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateCliRequest(request, requestId);
    const role = parseConsoleRole(auth.membership.role);
    if (!auth.scopes.includes(PAGES_OUTDATED_CLI_SCOPE) || !role) {
      return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    }
    const projectRef = request.nextUrl.searchParams.get("project")?.trim();
    if (!projectRef) {
      return noStore(cliFailure(cliApiError(400, "PAYLOAD_INVALID", "Pass project=<project slug or id>."), requestId));
    }
    const result = await listOutdatedPages({
      workspace: { authorization: projectAuthorizationFromCli(auth), user: { id: auth.user.id }, organization: { id: auth.organization.id }, membership: { role } },
      projectRef,
    });
    return noStore(cliSuccess(result));
  } catch (error) {
    return noStore(cliFailure(error, requestId));
  }
}

function noStore(response: Response) {
  response.headers.set("cache-control", "no-store");
  return response;
}
