import { BaseScreen } from "@/features/bases/base-screen";

export default async function BaseRowsPage({ params }: { params: Promise<{ projectId: string; baseRef: string }> }) {
  const { baseRef, projectId } = await params;
  return <BaseScreen baseRef={baseRef} projectId={projectId} tab="rows" />;
}
