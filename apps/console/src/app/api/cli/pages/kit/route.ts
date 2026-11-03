import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { basesCallerFromCliAuth } from "@/server/console/bases";
import { libraryOrigin } from "@/server/console/library/cli";
import { PAGE_KIT_MAX_BODY_BYTES, pageKitInvalidError, runPageKitForCli } from "@/server/console/pages/kit/service";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

// `ravi pages ship` sends the HTML files here before upload. Errors in the
// page answer 422 KIT_INVALID with the diagnostics in `error.details`.
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);
  try {
    const auth = await authenticateCliRequest(request, requestId);
    const role = parseConsoleRole(auth.membership.role);
    if (!role) return noStore(cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId));
    const body = await readJsonBody(request, requestId, { maxBytes: PAGE_KIT_MAX_BODY_BYTES });
    const result = await runPageKitForCli({
      body,
      origin: libraryOrigin(request.url),
      context: {
        user: { id: auth.user.id },
        organization: { id: auth.organization.id },
        membership: { role },
        scopes: auth.scopes,
        bases: basesCallerFromCliAuth(auth, requestId),
      },
    });
    const invalid = pageKitInvalidError(result);
    return noStore(invalid ? cliFailure(invalid, requestId) : cliSuccess(result));
  } catch (error) {
    return noStore(cliFailure(error, requestId));
  }
}

function noStore(response: Response) {
  response.headers.set("cache-control", "no-store");
  return response;
}
