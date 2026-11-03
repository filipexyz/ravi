import { ManageClientScreen } from "@/features/billing/manage-client-screen";

export const dynamic = "force-dynamic";

export default async function ManageClientPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <ManageClientScreen organizationId={id} />;
}
