import { type NextRequest } from "next/server";

import { authenticateCliRequest } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { cliFailure, cliSuccess, readJsonBody, requestIdFrom } from "@/server/cli/http";
import {
  createManagedInstallation,
} from "@/server/cli/installations";

export const runtime = "nodejs";

const MANAGE_ROLES = new Set(["owner", "admin"]);

/**
 * POST /api/cli/installations
 *
 * Creates an installation owned by the organization (no user subject) and a
 * single-use bootstrap token. The desired manifest is the body's `desired`
 * object. Only organization owners and admins may do it.
 */
export async function POST(request: NextRequest) {
  const requestId = requestIdFrom(request);

  try {
    const auth = await authenticateCliRequest(request, requestId, { actor: "executor" });
    if (!auth.scopes.includes("console.installations.write")) {
      throw cliApiError(403, "PROJECT_ACCESS_DENIED");
    }
    if (!MANAGE_ROLES.has(auth.membership.role)) {
      throw cliApiError(403, "ORG_ACCESS_DENIED", "Only organization owners and admins can create installations.");
    }

    const body = await readJsonBody(request, requestId, { maxBytes: 256 * 1024 });
    const parsed = await parseCreateBody(body);
    const created = await createManagedInstallation({
      organizationId: auth.organization.id,
      createdByUserId: auth.user.id,
      name: parsed.name,
      desired: parsed.desired,
      requestId,
    });

    return cliSuccess(
      {
        version: 1,
        installation: {
          id: created.installation.id,
          name: created.installation.name,
          organizationId: created.installation.organizationId,
          subjectType: created.installation.subjectType,
          installState: created.installation.installState,
        },
        bootstrapToken: created.token,
        bootstrapTokenExpiresAt: created.tokenExpiresAt.toISOString(),
        desired: {
          version: created.installation.desiredVersion,
          hash: created.installation.desiredHash,
          desired: created.installation.desiredJson,
        },
      },
      { status: 201 },
    );
  } catch (error) {
    return cliFailure(error, requestId);
  }
}

async function parseCreateBody(body: unknown) {
  if (!body || typeof body !== "object") throw cliApiError(400, "PAYLOAD_INVALID");
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (!name) throw cliApiError(400, "PAYLOAD_INVALID", "An installation name is required.");
  const desired = record.desired;
  if (!desired || typeof desired !== "object" || Array.isArray(desired)) {
    throw cliApiError(400, "PAYLOAD_INVALID", "`desired` must be the installation manifest object.");
  }
  return { name, desired: desired as Record<string, unknown> };
}
