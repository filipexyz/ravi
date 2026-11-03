import { LibraryScreen } from "@/features/library/library-screen";

export default async function ProjectLibraryPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <LibraryScreen projectId={projectId} />;
}
