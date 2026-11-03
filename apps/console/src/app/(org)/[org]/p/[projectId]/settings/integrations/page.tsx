import { IntegrationsScreen } from "@/features/project/integrations-screen";

export default async function ProjectIntegrationsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <IntegrationsScreen projectId={projectId} />;
}
