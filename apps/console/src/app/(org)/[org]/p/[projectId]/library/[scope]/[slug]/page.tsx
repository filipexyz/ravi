import { LibraryItemScreen } from "@/features/library/library-item-screen";

export default async function ProjectLibraryItemPage({
  params,
}: {
  params: Promise<{ projectId: string; scope: string; slug: string }>;
}) {
  const { projectId, scope, slug } = await params;
  return <LibraryItemScreen projectId={projectId} scope={decodeURIComponent(scope)} slug={decodeURIComponent(slug)} />;
}
