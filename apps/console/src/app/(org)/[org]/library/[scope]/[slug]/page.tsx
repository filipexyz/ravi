import { LibraryItemScreen } from "@/features/library/library-item-screen";

export default async function OrgLibraryItemPage({ params }: { params: Promise<{ scope: string; slug: string }> }) {
  const { scope, slug } = await params;
  return <LibraryItemScreen scope={decodeURIComponent(scope)} slug={decodeURIComponent(slug)} />;
}
