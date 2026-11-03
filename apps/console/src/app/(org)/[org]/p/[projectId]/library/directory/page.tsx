import { LibraryDirectoryScreen } from "@/features/library/library-directory-screen";

export default async function ProjectLibraryDirectoryPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <LibraryDirectoryScreen projectId={projectId} />;
}
