import { RunsScreen } from "@/features/console/screens";

export default async function ProjectRunsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <RunsScreen projectId={projectId} scope="project" />;
}
