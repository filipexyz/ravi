import { LibraryEditorScreen } from "@/features/library/library-editor-screen";

export default async function OrgLibraryProposePage({ params }: { params: Promise<{ scope: string; slug: string }> }) {
  const { scope, slug } = await params;
  return <LibraryEditorScreen mode={{ kind: "propose", scope: decodeURIComponent(scope), slug: decodeURIComponent(slug) }} />;
}
