import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { after, type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import { pagePublishCliError } from "@/server/console/pages/cli-errors";
import {
  activatePageSiteRelease,
  cliPublishContextFromAuth,
  createPageSiteRelease,
  finalizePageUploadSession,
} from "@/server/console/pages/publish";
import { refreshSiteThumbnails } from "@/server/console/pages/thumbnails";
import { parseConsoleRole } from "@/server/console/workspace";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId);
    const body = await readJsonBody(request, requestId);
    const record = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
    const context = cliPublishContextFromAuth(auth);

    if (typeof record.uploadSessionId === "string") {
      const result = await finalizePageUploadSession({
        context,
        input: record as Parameters<typeof finalizePageUploadSession>[0]["input"],
        requestId,
      });
      scheduleThumbnails(auth, result, requestId);
      return cliSuccess(serializePagePayload(result));
    }

    if (typeof record.releaseId === "string" && typeof record.siteRef === "string") {
      const result = await activatePageSiteRelease({
        context,
        input: record as Parameters<typeof activatePageSiteRelease>[0]["input"],
        requestId,
      });
      scheduleThumbnails(auth, result, requestId);
      return cliSuccess(serializePagePayload(result));
    }

    const result = await createPageSiteRelease({
      context,
      input: record as Parameters<typeof createPageSiteRelease>[0]["input"],
      requestId,
    });
    scheduleThumbnails(auth, result, requestId);
    return cliSuccess(serializePagePayload(result), { status: 201 });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pagePublishCliError(error), requestId);
    }
    return cliFailure(error, requestId);
  }
}

/**
 * Once a release is live, captures thumbnails of the host's newest pages as the
 * publisher, after the response. A capture failure never touches the release.
 */
function scheduleThumbnails(
  auth: Awaited<ReturnType<typeof authenticateCliRequest>>,
  result: { site: { id: string } | null; release: { status: string } | null },
  requestId: string,
) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role || !result.site || result.release?.status !== "active") return;
  const siteId = result.site.id;
  after(() =>
    refreshSiteThumbnails({
      requestId,
      siteId,
      workspace: { authorization: projectAuthorizationFromCli(auth),
        mode: "workos",
        membership: { role },
        organization: { id: auth.organization.id },
        user: { id: auth.user.id },
      },
    }).catch((error: unknown) => {
      console.warn("Ravi Pages thumbnails after publish failed", { requestId, error: String(error) });
    }),
  );
}

function serializePagePayload(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(serializePagePayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializePagePayload(item)]),
    );
  }
  return value;
}
