import { PagesSettingsScreen } from "@/features/pages/settings-screen";

export default async function PagesSettingsPage({ params }: { params: Promise<{ projectId: string; siteId: string }> }) {
  const { projectId, siteId } = await params;
  return <PagesSettingsScreen projectId={projectId} siteId={siteId} />;
}
