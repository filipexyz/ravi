import { ArtifactsScreen } from "@/features/console/screens";

export default async function ArtifactsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ArtifactsScreen projectId={projectId} />;
}

