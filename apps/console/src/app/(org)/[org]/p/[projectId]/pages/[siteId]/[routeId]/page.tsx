import { PageScreen } from "@/features/pages/page-screen";

export default async function PageDetailPage({
  params,
}: {
  params: Promise<{ projectId: string; routeId: string; siteId: string }>;
}) {
  const { projectId, routeId, siteId } = await params;
  return <PageScreen projectId={projectId} routeId={routeId} siteId={siteId} />;
}
