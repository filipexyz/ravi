import { BugOpsDetailScreen } from "@/features/console/bug-ops-screen";

export const dynamic = "force-dynamic";

export default async function ManageBugDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <BugOpsDetailScreen id={id} />;
}
