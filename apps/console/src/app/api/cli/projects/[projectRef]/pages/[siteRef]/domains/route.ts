import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import { ConsoleApiError } from "@/server/console/api-error";
import {
  consolePageDomainSetupDetails,
  formatConsolePageDomainSetupRequired,
  setupConsolePageDomainForSite,
} from "@/server/console/domains";
import { getPageSiteForProject } from "@/server/console/pages";
import { parseConsoleRole } from "@/server/console/workspace";

type RouteContext = {
  params: Promise<{ projectRef: string; siteRef: string }>;
};

export const runtime = "nodejs";

export async function POST(request: NextRequest, context: RouteContext) {
  const requestId = requestIdFrom(request);
  const { projectRef, siteRef } = await context.params;

  try {
    const auth = await authenticateCliRequest(request, requestId);
    if (!auth.scopes.includes("console.projects.link")) {
      return cliFailure(cliApiError(403, "PROJECT_ACCESS_DENIED"), requestId);
    }

    const workspace = workspaceFromCliAuth(auth);
    const site = await getPageSiteForProject({
      action: "write",
      projectRef,
      siteRef,
      workspace,
    });
    const input = parseBindDomainsInput(await readJsonBody(request, requestId, { maxBytes: 8192 }));
    const setups = [];

    for (const hostname of input.hostnames) {
      const setup = await setupConsolePageDomainForSite({
        hostname,
        requestId,
        siteId: site.id,
        workspace,
      });
      setups.push(setup);
    }

    if (setups.some((setup) => setup.state !== "ready")) {
      // Released CLI clients preserve the server message but map unknown 409
      // codes to login-pending. Keep 400 until the public client recognizes
      // DOMAIN_SETUP_REQUIRED so the compatibility code remains PAYLOAD_INVALID.
      throw cliApiError(
        400,
        "DOMAIN_SETUP_REQUIRED",
        formatConsolePageDomainSetupRequired(setups),
        consolePageDomainSetupDetails(setups),
      );
    }

    const bindings = setups.flatMap((setup) => (setup.binding ? [setup.binding] : []));

    return cliSuccess({
      bindings,
      hostnames: input.hostnames,
      projectRef,
      site,
      siteRef,
      total: bindings.length,
    });
  } catch (error) {
    if (error instanceof ConsoleApiError) {
      return cliFailure(pageDomainCliError(error), requestId);
    }
    return cliFailure(error, requestId);
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
    user: auth.user,
    organization: auth.organization,
    membership: { ...auth.membership, role },
  };
}

function parseBindDomainsInput(input: unknown) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ConsoleApiError(400, { error: "invalid_request" });
  }

  const record = input as Record<string, unknown>;
  const values = [
    typeof record.hostname === "string" ? record.hostname : null,
    ...(Array.isArray(record.hostnames) ? record.hostnames : []),
  ];
  const hostnames = [...new Set(values.map((value) => (typeof value === "string" ? value.trim() : "")).filter(Boolean))];
  if (hostnames.length === 0) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { hostnames: "At least one hostname is required." },
    });
  }
  if (hostnames.length > 20) {
    throw new ConsoleApiError(400, {
      error: "validation_failed",
      fieldErrors: { hostnames: "Bind at most 20 hostnames per request." },
    });
  }

  return { hostnames };
}

function pageDomainCliError(error: ConsoleApiError) {
  if (
    error.payload.error === "domain_binding_conflict" ||
    error.payload.error === "domain_binding_unavailable" ||
    error.payload.error === "domain_binding_product_unavailable" ||
    error.payload.error === "domain_binding_target_required" ||
    error.payload.error === "domain_binding_target_unavailable" ||
    error.payload.error === "domain_claim_not_verified" ||
    error.payload.error === "domain_unavailable" ||
    error.payload.error === "invalid_request" ||
    error.payload.error === "validation_failed"
  ) {
    return cliApiError(400, "PAYLOAD_INVALID");
  }

  if (
    error.payload.error === "forbidden" ||
    error.payload.error === "project_forbidden" ||
    error.payload.error === "project_not_found" ||
    error.payload.error === "site_not_found"
  ) {
    return cliApiError(403, "PROJECT_ACCESS_DENIED");
  }

  return cliApiError(503, "SERVER_UNAVAILABLE");
}
