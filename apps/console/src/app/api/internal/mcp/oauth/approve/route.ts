import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";

import { getConsoleAuthState } from "@/lib/auth/session";
import { assertInternalConsoleFeature } from "@/server/console/internal-feature-api";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { getInternalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { db, schema } from "@/server/db";
import { createOAuthAuthorization } from "@/server/mcp/write";
import { and, eq } from "drizzle-orm";

export const runtime = "nodejs";

const bodySchema = z.object({
  bridgeId: z.string().uuid(),
  clientId: z.string().min(1).max(200),
  redirectUri: z.string().url(),
  state: z.string().max(500).nullable().optional(),
  scope: z.string().max(1000).optional(),
  codeChallenge: z.string().min(20).max(200),
  codeChallengeMethod: z.literal("S256"),
});

const SUPPORTED_SCOPES = new Set([
  "mcp.bridge.connect",
  "mcp.bridge.tools.read",
  "mcp.bridge.tools.invoke",
  "mcp.bridge.tools.invoke_destructive",
  "mcp.bridge.resources.read",
  "mcp.bridge.prompts.read",
  "mcp.console.tools.read",
  "mcp.console.tools.write",
]);

export async function POST(request: Request) {
  const requestId = request.headers.get("x-request-id") ?? randomUUID();
  const authState = await getConsoleAuthState();
  if (!authState) return jsonError(401, "unauthorized", requestId);

  const parsed = await parseBody(request);
  if (!parsed) return jsonError(400, "payload_invalid", requestId);

  const workspace = await getInternalSelectedConsoleWorkspace(authState, requestId);
  if (workspace instanceof NextResponse) return workspace;
  const featureError = await assertInternalConsoleFeature(workspace, "console.connectors", requestId);
  if (featureError) return featureError;

  const [bridge] = await db
    .select()
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.id, parsed.bridgeId),
        eq(schema.mcpBridges.organizationId, workspace.organization.id),
      ),
    )
    .limit(1);
  if (!bridge) return jsonError(404, "bridge_not_found", requestId);

  const project = await findAccessibleProjectRecord(workspace, bridge.projectId, "read");
  if (!project) return jsonError(403, "project_forbidden", requestId);

  const [client] = await db
    .select()
    .from(schema.mcpOAuthClients)
    .where(
      and(
        eq(schema.mcpOAuthClients.clientId, parsed.clientId),
        eq(schema.mcpOAuthClients.bridgeId, bridge.id),
      ),
    )
    .limit(1);
  if (!client || !client.redirectUrisJson.includes(parsed.redirectUri)) {
    return jsonError(400, "payload_invalid", requestId);
  }

  const scopes = parseScopes(parsed.scope);
  if (!scopes) return jsonError(400, "payload_invalid", requestId);

  const { code } = await createOAuthAuthorization({
    organizationId: workspace.organization.id,
    projectId: bridge.projectId,
    bridgeId: bridge.id,
    oauthClientId: client.id,
    subjectUserId: workspace.user.id,
    codeChallenge: parsed.codeChallenge,
    codeChallengeMethod: parsed.codeChallengeMethod,
    scopes,
    redirectUri: parsed.redirectUri,
    state: parsed.state,
  });

  const redirectTo = new URL(parsed.redirectUri);
  redirectTo.searchParams.set("code", code);
  if (parsed.state) redirectTo.searchParams.set("state", parsed.state);
  return NextResponse.json(
    { status: "ok", redirectTo: redirectTo.toString() },
    { status: 201, headers: { "x-request-id": requestId } },
  );
}

async function parseBody(request: Request) {
  try {
    return bodySchema.parse(await request.json());
  } catch {
    return null;
  }
}

function parseScopes(scope: string | undefined) {
  const requested = scope?.split(/\s+/).filter(Boolean) ?? ["mcp.bridge.connect"];
  const scopes: string[] = [];
  for (const value of requested) {
    if (!SUPPORTED_SCOPES.has(value)) return null;
    if (!scopes.includes(value)) scopes.push(value);
  }
  if (!scopes.includes("mcp.bridge.connect")) scopes.unshift("mcp.bridge.connect");
  return scopes.length ? scopes : ["mcp.bridge.connect"];
}

function jsonError(status: number, code: string, requestId: string): NextResponse {
  return NextResponse.json(
    { status: "error", code },
    { status, headers: { "x-request-id": requestId } },
  );
}
