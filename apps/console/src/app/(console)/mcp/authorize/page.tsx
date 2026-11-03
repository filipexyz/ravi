import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { McpConsentScreen } from "@/features/account/mcp-consent-screen";
import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { getOptionalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { db, schema } from "@/server/db";
import { and, eq } from "drizzle-orm";

import { ConsentForm } from "./consent-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Allow access · Ravi Console",
  robots: { index: false, follow: false },
};

export default async function McpAuthorizePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const bridgeId = stringParam(params.bridge_id);
  const clientId = stringParam(params.client_id);
  const redirectUri = stringParam(params.redirect_uri);
  const scope = stringParam(params.scope) ?? "mcp.bridge.connect";
  const state = stringParam(params.state);
  const codeChallenge = stringParam(params.code_challenge);
  const codeChallengeMethod = stringParam(params.code_challenge_method);

  if (!bridgeId || !clientId || !redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    notFound();
  }

  const authState = await getConsoleAuthState();
  const workspace = await getOptionalSelectedConsoleWorkspace(authState);
  if (!workspace) return null;
  try {
    await assertConsoleFeatureAccess(workspace, "console.connectors");
  } catch (error) {
    if (error instanceof ConsoleApiError) notFound();
    throw error;
  }

  const [bridge] = await db
    .select()
    .from(schema.mcpBridges)
    .where(
      and(
        eq(schema.mcpBridges.id, bridgeId),
        eq(schema.mcpBridges.organizationId, workspace.organization.id),
      ),
    )
    .limit(1);
  if (!bridge) notFound();

  const project = await findAccessibleProjectRecord(workspace, bridge.projectId, "read");
  if (!project) notFound();

  const [client] = await db
    .select()
    .from(schema.mcpOAuthClients)
    .where(
      and(
        eq(schema.mcpOAuthClients.clientId, clientId),
        eq(schema.mcpOAuthClients.bridgeId, bridge.id),
      ),
    )
    .limit(1);
  if (!client || !client.redirectUrisJson.includes(redirectUri)) notFound();

  return (
    <McpConsentScreen
      actions={
        <ConsentForm
          bridgeId={bridge.id}
          cancelHref="/projects"
          clientId={client.clientId}
          codeChallenge={codeChallenge}
          codeChallengeMethod={codeChallengeMethod}
          redirectUri={redirectUri}
          scope={scope}
          state={state}
        />
      }
      bridgeName={bridge.name}
      clientName={client.clientName}
      projectName={project.name}
      redirectUri={redirectUri}
      scopes={scope.split(/\s+/).filter(Boolean)}
    />
  );
}

function stringParam(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

