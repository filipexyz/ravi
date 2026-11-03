import { ArtifactDetailScreen } from "@/features/console/screens";

export default async function ArtifactDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; artifactId: string }>;
}) {
  const { projectId, artifactId } = await params;
  return <ArtifactDetailScreen artifactId={artifactId} projectId={projectId} />;
}

