import { BasesListScreen } from "@/features/bases/bases-list-screen";

export default async function BasesPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <BasesListScreen projectId={projectId} />;
}
