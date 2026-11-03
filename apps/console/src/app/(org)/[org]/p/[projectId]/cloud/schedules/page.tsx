import { CloudSchedulesScreen } from "@/features/cloud-agents/schedules-tab";

export default async function CloudSchedulesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <CloudSchedulesScreen projectId={projectId} />;
}
