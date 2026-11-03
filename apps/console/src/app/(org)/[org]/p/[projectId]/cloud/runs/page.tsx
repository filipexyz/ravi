import { CloudRunsScreen } from "@/features/cloud-agents/runs-tab";

export default async function CloudRunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CloudRunsScreen projectId={projectId} />;
}
