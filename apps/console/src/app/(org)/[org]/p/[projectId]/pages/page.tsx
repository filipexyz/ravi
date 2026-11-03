import { PagesScreen } from "@/features/pages/pages-screen";

export default async function PagesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <PagesScreen projectId={projectId} />;
}
