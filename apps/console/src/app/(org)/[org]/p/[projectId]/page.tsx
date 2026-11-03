import { ProjectOverviewScreen } from "@/features/project/overview-screen";

export default async function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ProjectOverviewScreen projectId={projectId} />;
}
