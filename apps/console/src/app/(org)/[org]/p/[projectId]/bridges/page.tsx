import { notFound } from "next/navigation";

import { getConsoleAuthState } from "@/lib/auth/session";
import { ConsoleApiError } from "@/server/console/api-error";
import { assertConsoleFeatureAccess } from "@/server/console/feature-access";
import { findAccessibleProjectRecord } from "@/server/console/project-access";
import { getOptionalSelectedConsoleWorkspace } from "@/server/console/request-workspace";
import { listConsoleMcpBridges } from "@/server/mcp/console-client";

import { BridgesPanel } from "./bridges-panel";

export const dynamic = "force-dynamic";

export default async function ProjectBridgesPage({
  params,
}: {
  params: Promise<{ org: string; projectId: string }>;
}) {
  const { org, projectId } = await params;
  const authState = await getConsoleAuthState();
  const workspace = await getOptionalSelectedConsoleWorkspace(authState, { organizationRef: org });
  if (!workspace) return null;
  try {
    await assertConsoleFeatureAccess(workspace, "console.connectors");
  } catch (error) {
    if (error instanceof ConsoleApiError) notFound();
    throw error;
  }

  const project = await findAccessibleProjectRecord(workspace, projectId, "read");
  if (!project) notFound();

  const bridges = await listConsoleMcpBridges(
    { userId: workspace.user.id, organizationId: workspace.organization.id },
    { projectId: project.id },
  );

  return (
    <BridgesPanel
      initialBridges={bridges}
      projectId={project.id}
      projectName={project.name}
      projectSlug={project.slug}
    />
  );
}
