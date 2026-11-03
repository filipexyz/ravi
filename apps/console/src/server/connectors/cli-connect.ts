/**
 * `POST /api/cli/connectors/connect/start`: the CLI asks the Console to start
 * a connection for the signed-in operator. The Console applies the single
 * "who can connect" rule and forwards the CLI session and installation to
 * the Worker, which returns the Console page `/connect/<token>` the same
 * person must open.
 */

import { z } from "zod";

import type { CliAuthContext } from "@/server/cli/auth";
import { cliApiError } from "@/server/cli/errors";
import { getConsoleFeatureAccessForOrganizationRole } from "@/server/console/feature-access";
import { CONNECTION_NAME_MAX_LENGTH } from "@/shared/integrations/connection-limits";

import { ConsoleConnectorClientError, startConnect } from "./console-client";

const cliConnectStartSchema = z.object({
  provider: z.string().trim().min(1).max(60),
  accessMode: z.enum(["full", "read_only"]).optional(),
  reconnectConnectionId: z.string().uuid().optional(),
  displayName: z.string().trim().min(1).max(CONNECTION_NAME_MAX_LENGTH).optional(),
  // Accepted and ignored until 2027-01-01: connections belong to a person.
  projectId: z.unknown().optional(),
});

export type CliConnectStartResponse = {
  connectUrl: string;
  pendingGrantId: string;
  expiresAt: string;
};

/**
 * Active membership is already checked by `authenticateCliRequest`; the role
 * must also be authorized for `console.connectors`.
 */
export async function assertCliCanConnect(auth: CliAuthContext) {
  const access = await getConsoleFeatureAccessForOrganizationRole({
    organizationId: auth.organization.id,
    role: auth.membership.role,
  });
  const feature = access.byKey["console.connectors"];
  if (!feature.available) {
    throw cliApiError(403, "ORG_ACCESS_DENIED", `Connectors aren't enabled for ${auth.organization.name}.`);
  }
  if (!feature.authorized) {
    throw cliApiError(
      403,
      "ORG_ACCESS_DENIED",
      `Your role in ${auth.organization.name} doesn't include connectors. Ask an owner or admin.`,
    );
  }
}

export async function startCliConnect(input: { auth: CliAuthContext; body: unknown }): Promise<CliConnectStartResponse> {
  const parsed = cliConnectStartSchema.safeParse(input.body);
  if (!parsed.success) {
    throw cliApiError(400, "PAYLOAD_INVALID", "Send provider, and optionally accessMode, reconnectConnectionId and displayName.");
  }
  await assertCliCanConnect(input.auth);

  let result: Awaited<ReturnType<typeof startConnect>>;
  try {
    result = await startConnect(
      { organizationId: input.auth.organization.id, userId: input.auth.user.id },
      {
        accessMode: parsed.data.accessMode,
        cliSessionId: input.auth.cliSession.id,
        displayName: parsed.data.displayName,
        localInstallationId: input.auth.localInstallation.id,
        origin: "cli",
        provider: parsed.data.provider,
        reconnectConnectionId: parsed.data.reconnectConnectionId,
      },
    );
  } catch (error) {
    throw cliErrorFromConnector(error);
  }

  if (!result?.connectUrl || !result.pendingGrantId || !result.expiresAt) {
    throw cliApiError(503, "SERVER_UNAVAILABLE", "Connectors returned an incomplete answer. Try again in a moment.");
  }
  return { connectUrl: result.connectUrl, expiresAt: result.expiresAt, pendingGrantId: result.pendingGrantId };
}

/** Worker codes in CLI terms. Messages are fixed; nothing from the Worker is echoed. */
export function cliErrorFromConnector(error: unknown): unknown {
  if (!(error instanceof ConsoleConnectorClientError)) return error;
  if (error.code === "connector_disabled_by_org") return cliApiError(403, "CONNECTOR_DISABLED_BY_ORG");
  if (error.code === "server_not_configured") {
    return cliApiError(503, "SERVER_UNAVAILABLE", "Connectors aren't set up on this Console.");
  }
  if (error.status === 400) {
    return cliApiError(400, "PAYLOAD_INVALID", "Connectors didn't accept this request. Check the provider name.");
  }
  if (error.status === 404) {
    return cliApiError(404, "NOT_FOUND", "That connection wasn't found, or it isn't yours.");
  }
  if (error.status === 403) return cliApiError(403, "ORG_ACCESS_DENIED", "Connectors refused this request.");
  if (error.status === 429) return cliApiError(429, "RATE_LIMITED");
  return cliApiError(503, "SERVER_UNAVAILABLE", "Connectors are temporarily unavailable. Try again in a moment.");
}
