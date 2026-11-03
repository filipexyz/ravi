import { CloudRunScreen } from "@/features/cloud-agents/run-screen";

export default async function CloudRunPage({ params }: { params: Promise<{ projectId: string; runId: string }> }) {
  const { projectId, runId } = await params;
  return <CloudRunScreen projectId={projectId} runId={runId} />;
}
