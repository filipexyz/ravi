import { ActivityScreen } from "@/features/project/activity-screen";

export default async function ProjectActivityPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <ActivityScreen projectId={projectId} />;
}
