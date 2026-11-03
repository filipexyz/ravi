import { PagesScreen } from "@/features/pages/pages-screen";

/**
 * The page's top bar links here. It is the list: filtered to this host when it
 * is an older one, and `?path=/x` opens that page.
 */
export default async function PageSitePage({ params }: { params: Promise<{ projectId: string; siteId: string }> }) {
  const { projectId, siteId } = await params;
  return <PagesScreen projectId={projectId} siteId={siteId} />;
}
