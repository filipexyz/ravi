import { projectAuthorizationFromCli } from "@/server/cli/project-authorization";
import { cliApiError } from "@/server/cli/errors";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { parseConsoleRole } from "@/server/console/workspace";
import type { CliAuthContext } from "@/server/cli/auth";
import {
  createConsoleMcpBridge,
  listConsoleMcpBridges,
  revokeConsoleMcpBridge,
} from "@/server/mcp/console-client";

export async function listCliMcpBridges(input: {
  auth: CliAuthContext;
  projectRef: string;
}) {
  requireScope(input.auth, "console.projects.read");
  const workspace = workspaceFromCliAuth(input.auth);
  const project = await findAccessibleProjectRecord(workspace, input.projectRef, "read");
  if (!project) throw cliApiError(404, "PROJECT_ACCESS_DENIED");
  return {
    bridges: await listConsoleMcpBridges(actorFromAuth(input.auth), { projectId: project.id }),
  };
}

export async function createCliMcpBridge(input: {
  auth: CliAuthContext;
  projectRef: string;
  body: unknown;
}) {
  requireScope(input.auth, "console.projects.link");
  const workspace = workspaceFromCliAuth(input.auth);
  const project = await findAccessibleProjectRecord(workspace, input.projectRef, "write");
  if (!project) throw cliApiError(404, "PROJECT_ACCESS_DENIED");

  const body = parseCreateBody(input.body);
  const result = await createConsoleMcpBridge(actorFromAuth(input.auth), {
    projectId: project.id,
    name: body.name,
    description: body.description,
    allowedCapabilityClasses: body.allowedCapabilityClasses,
  });

  return {
    bridge: {
      id: result.bridge.id,
      name: result.bridge.name,
      projectId: result.bridge.projectId,
      status: result.bridge.status,
      createdAt: result.bridge.createdAt.toISOString(),
    },
    bridgeToken: result.bridgeToken,
    bridgeUrl: result.bridgeUrl,
  };
}

export async function revokeCliMcpBridge(input: {
  auth: CliAuthContext;
  bridgeId: string;
}) {
  requireScope(input.auth, "console.projects.link");
  const bridge = await revokeConsoleMcpBridge(actorFromAuth(input.auth), {
    bridgeId: input.bridgeId,
  });
  if (!bridge) throw cliApiError(404, "PROJECT_ACCESS_DENIED");
  return { revoked: true, bridgeId: bridge.id };
}

function requireScope(auth: CliAuthContext, scope: string) {
  if (!auth.scopes.includes(scope)) {
    throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  }
}

function actorFromAuth(auth: CliAuthContext) {
  return {
    userId: auth.user.id,
    organizationId: auth.organization.id,
  };
}

function workspaceFromCliAuth(auth: CliAuthContext) {
  const role = parseConsoleRole(auth.membership.role);
  if (!role) throw cliApiError(403, "PROJECT_ACCESS_DENIED");
  return {
    authorization: projectAuthorizationFromCli(auth),
    mode: "workos" as const,
    user: auth.user,
    organization: auth.organization,
    membership: { ...auth.membership, role },
  };
}

function parseCreateBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw cliApiError(400, "PAYLOAD_INVALID");
  }
  const record = body as Record<string, unknown>;
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "MCP Bridge";
  const description = typeof record.description === "string" ? record.description : undefined;
  const allowedCapabilityClasses = Array.isArray(record.allowedCapabilityClasses)
    ? record.allowedCapabilityClasses.filter((value): value is string => typeof value === "string")
    : undefined;
  return { name, description, allowedCapabilityClasses };
}
