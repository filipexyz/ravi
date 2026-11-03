import { GeneralSettingsScreen } from "@/features/project/general-settings-screen";

export default async function ProjectSettingsPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <GeneralSettingsScreen projectId={projectId} />;
}
