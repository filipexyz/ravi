import { CloudAgentsScreen } from "@/features/cloud-agents/agents-tab";

export default async function CloudAgentsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CloudAgentsScreen projectId={projectId} />;
}
