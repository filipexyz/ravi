import { LibraryEditorScreen } from "@/features/library/library-editor-screen";

export default async function ProjectLibraryProposePage({
  params,
}: {
  params: Promise<{ projectId: string; scope: string; slug: string }>;
}) {
  const { projectId, scope, slug } = await params;
  return (
    <LibraryEditorScreen
      mode={{ kind: "propose", scope: decodeURIComponent(scope), slug: decodeURIComponent(slug) }}
      projectId={projectId}
    />
  );
}
