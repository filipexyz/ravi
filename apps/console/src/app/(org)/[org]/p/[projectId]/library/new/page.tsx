import { LibraryEditorScreen } from "@/features/library/library-editor-screen";

export default async function ProjectLibraryNewPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = await params;
  return <LibraryEditorScreen mode={{ kind: "new" }} projectId={projectId} />;
}
